/**
 * Единственный слой, знающий про Prisma.
 *
 * Клиент приходит параметром, а не берётся из синглтона: так проверки работают
 * с временной базой, не трогая рабочую, а сервисный слой остаётся свободным от
 * знания о том, откуда взялось соединение.
 */
import type { AssetView } from '../asset';
import type { EngineDb } from '../db';
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

export async function findAssetByPath(
  db: EngineDb,
  relativePath: string
): Promise<AssetView | null> {
  const row = await db.asset.findUnique({
    where: { relativePath },
    include: WITH_PROVENANCE
  });
  return row ? toAssetView(row) : null;
}

export type CreateAssetInput = {
  relativePath: string;
  type: MediaKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
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

export async function listAssets(db: EngineDb): Promise<AssetView[]> {
  const rows = await db.asset.findMany({
    include: WITH_PROVENANCE,
    orderBy: { relativePath: 'asc' }
  });
  return rows.map(toAssetView);
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
