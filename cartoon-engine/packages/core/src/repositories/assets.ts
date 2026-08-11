/**
 * Единственный слой, знающий про Prisma.
 *
 * Клиент приходит параметром, а не берётся из синглтона: так проверки работают
 * с временной базой, не трогая рабочую, а сервисный слой остаётся свободным от
 * знания о том, откуда взялось соединение.
 */
import type { AssetView } from '../asset';
import type { EngineDb } from '../db';
import { InvariantError } from '../errors';
import type { MediaKind } from '../media-store';
import type { ProducedBy, ProvenanceDraft, Reproducibility } from '../provenance';

/** Строка вместе с происхождением — иначе она неполна. */
const WITH_PROVENANCE = { provenance: true } as const;

type AssetRow = {
  id: string;
  relativePath: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  role: string | null;
  characterId: string | null;
  version: number;
  supersedesId: string | null;
  createdAt: Date;
  provenance: {
    producedBy: string;
    reproducibility: string;
    note: string | null;
  } | null;
};

/**
 * Строка базы → доменный вид.
 *
 * Приведение типов здесь узкое и осознанное: в SQLite нет перечислений, поэтому
 * producedBy и reproducibility хранятся строками. Записать туда произвольное
 * значение невозможно — на входе стоит assertValidProvenance, — а проверять то
 * же самое второй раз на выходе значило бы не доверять собственной записи.
 */
export function toAssetView(row: AssetRow): AssetView {
  return {
    id: row.id,
    relativePath: row.relativePath,
    type: row.type as MediaKind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    role: row.role,
    characterId: row.characterId,
    version: row.version,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt.toISOString(),
    provenance: row.provenance
      ? {
          producedBy: row.provenance.producedBy as ProducedBy,
          reproducibility: row.provenance.reproducibility as Reproducibility,
          note: row.provenance.note
        }
      : null
  };
}

export async function findAssetBySha256(
  db: EngineDb,
  sha256: string
): Promise<AssetView | null> {
  const row = await db.asset.findUnique({
    where: { sha256 },
    include: WITH_PROVENANCE
  });
  return row ? toAssetView(row) : null;
}

/**
 * Текущая версия по пути — та, у которой номер наибольший.
 *
 * Именно так, а не через «у кого нет ссылки supersededBy». Оба определения
 * равносильны, пока цепочка цела, но версия — обычная колонка с индексом, а
 * обратная связь потребовала бы фильтра по отношению. Проще то, что читается
 * без объяснений.
 */
export async function findCurrentVersionByPath(
  db: EngineDb,
  relativePath: string
): Promise<AssetView | null> {
  const row = await db.asset.findFirst({
    where: { relativePath },
    orderBy: { version: 'desc' },
    include: WITH_PROVENANCE
  });
  return row ? toAssetView(row) : null;
}

/** Вся история по пути, от первой версии к последней. */
export async function listVersionsByPath(
  db: EngineDb,
  relativePath: string
): Promise<AssetView[]> {
  const rows = await db.asset.findMany({
    where: { relativePath },
    orderBy: { version: 'asc' },
    include: WITH_PROVENANCE
  });
  return rows.map(toAssetView);
}

export type CreateAssetInput = {
  relativePath: string;
  type: MediaKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  role: string | null;
  characterId: string | null;
  version: number;
  supersedesId: string | null;
  provenance: ProvenanceDraft;
};

/**
 * Ассет и его происхождение создаются одной вложенной записью.
 *
 * Не двумя вызовами подряд: ассет без происхождения — это ровно то состояние,
 * ради исключения которого затевался реестр. Вложенная запись у Prisma
 * атомарна, поэтому промежуточного состояния не существует даже при падении.
 */
export async function createAssetWithProvenance(
  db: EngineDb,
  input: CreateAssetInput
): Promise<AssetView> {
  const row = await db.asset.create({
    data: {
      relativePath: input.relativePath,
      type: input.type,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      role: input.role,
      characterId: input.characterId,
      version: input.version,
      supersedesId: input.supersedesId,
      provenance: {
        create: {
          producedBy: input.provenance.producedBy,
          reproducibility: input.provenance.reproducibility,
          note: input.provenance.note
        }
      }
    },
    include: WITH_PROVENANCE
  });

  return toAssetView(row);
}

/**
 * Проставить роль и персонажа там, где их ещё нет.
 *
 * Заполняются ТОЛЬКО пустые поля. Замена уже проставленного значения на другое
 * — не уточнение, а переписывание решения, и она запрещена: если роль
 * действительно изменилась, это должно быть видимым действием человека, а не
 * побочным эффектом повторного импорта.
 *
 * Ни путь, ни отпечаток, ни версия, ни происхождение здесь не трогаются:
 * классификация говорит, ЧЕМ файл является, и ничего не сообщает о его байтах.
 */
export async function classifyAsset(
  db: EngineDb,
  assetId: string,
  classification: { role?: string; characterId?: string }
): Promise<{ asset: AssetView; changed: boolean }> {
  const existing = await db.asset.findUnique({
    where: { id: assetId },
    include: WITH_PROVENANCE
  });

  if (!existing) {
    throw new InvariantError(`Ассет ${assetId} исчез между чтением и записью.`);
  }

  const patch: { role?: string; characterId?: string } = {};

  if (classification.role !== undefined && existing.role !== classification.role) {
    if (existing.role !== null) {
      throw new InvariantError(
        `У ассета ${existing.relativePath} уже проставлена роль ${existing.role}, ` +
          `а импорт предлагает ${classification.role}. Смена роли — отдельное ` +
          'решение, а не побочный эффект повторного импорта.'
      );
    }
    patch.role = classification.role;
  }

  if (
    classification.characterId !== undefined &&
    existing.characterId !== classification.characterId
  ) {
    if (existing.characterId !== null) {
      throw new InvariantError(
        `Ассет ${existing.relativePath} уже привязан к другому персонажу. ` +
          'Перепривязка — отдельное решение.'
      );
    }
    patch.characterId = classification.characterId;
  }

  if (Object.keys(patch).length === 0) {
    return { asset: toAssetView(existing), changed: false };
  }

  const updated = await db.asset.update({
    where: { id: assetId },
    data: patch,
    include: WITH_PROVENANCE
  });

  return { asset: toAssetView(updated), changed: true };
}

export async function listAssets(db: EngineDb): Promise<AssetView[]> {
  const rows = await db.asset.findMany({
    include: WITH_PROVENANCE,
    orderBy: [{ relativePath: 'asc' }, { version: 'asc' }]
  });
  return rows.map(toAssetView);
}

/** Текущие версии всех путей — то, что реально лежит на диске. */
export async function listCurrentAssets(db: EngineDb): Promise<AssetView[]> {
  const all = await listAssets(db);
  const byPath = new Map<string, AssetView>();
  for (const asset of all) {
    const known = byPath.get(asset.relativePath);
    if (!known || asset.version > known.version) byPath.set(asset.relativePath, asset);
  }
  return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function countAssets(db: EngineDb): Promise<number> {
  return db.asset.count();
}

/** Уникальный индекс нарушен: строку успел создать соседний вызов. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
