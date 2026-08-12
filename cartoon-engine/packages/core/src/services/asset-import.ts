/**
 * Правила регистрации файла в реестре.
 *
 * Порядок шагов важен: сначала факты о файле, потом поиск уже известного, и
 * только потом запись. Ничего не пишется до того, как файл прочитан целиком, —
 * иначе оборванное чтение оставило бы строку с отпечатком, которому нечего
 * соответствовать.
 *
 * Файл здесь только читается. Ни перемещения, ни копирования, ни переименования
 * в этом модуле нет и быть не может: реестр описывает дерево, а не управляет им.
 *
 * Главное правило версионирования: СТАРАЯ СТРОКА НЕ ИЗМЕНЯЕТСЯ НИКОГДА. Новая
 * версия ссылается на предыдущую, а не предыдущая на новую, поэтому появление
 * версии физически не может тронуть прошлое. Старый файл на диске тоже никто не
 * удаляет — система лишь фиксирует, что байты стали другими.
 */
import type { AssetClassification, AssetView, ImportOutcome } from '../asset';
import type { EngineDb } from '../db';
import { ConcurrentImportError } from '../errors';
import type { MediaFacts, MediaStore } from '../media-store';
import { assertValidProvenance, importedProvenance } from '../provenance';
import type { ProvenanceDraft } from '../provenance';
import {
  classifyAsset,
  recordAssetAlias,
  createAssetWithProvenance,
  findAssetBySha256,
  findCurrentVersionByPath,
  isUniqueConstraintError
} from '../repositories/assets';

export type ImportDeps = {
  store: MediaStore;
  db: EngineDb;
};

export type ImportOptions = {
  provenance?: ProvenanceDraft;
  classification?: AssetClassification;
  /**
   * Записать найденную копию псевдонимом вместо того, чтобы сообщить о ней как
   * о конфликте.
   *
   * Флаг обязателен и по умолчанию выключен. Копия в дереве — это либо
   * осознанное решение (оригиналы, из которых копировали материал), либо
   * беспорядок, и отличить одно от другого может только человек. Молча
   * записывать псевдоним значило бы принять это решение за него.
   */
  aliasNote?: string | null;
};

/**
 * Зарегистрировать файл.
 *
 * Дедупликация идёт по sha256, а не по пути. Путь — это место, отпечаток — сам
 * файл: переименованный эталон остаётся тем же эталоном, а два разных рендера
 * по одному пути одним файлом не становятся.
 */
export async function importFile(
  deps: ImportDeps,
  relativePath: string,
  options: ImportOptions = {}
): Promise<ImportOutcome> {
  const provenance = options.provenance ?? importedProvenance();
  const classification = options.classification ?? {};
  assertValidProvenance(provenance);

  const facts = await deps.store.describe(relativePath);
  const current = await findCurrentVersionByPath(deps.db, facts.relativePath);

  // --- путь ещё не знаком -----------------------------------------------------
  if (!current) {
    const byContent = await findAssetBySha256(deps.db, facts.sha256);
    if (byContent) {
      return conflictOrAlias(deps, byContent, facts.relativePath, options.aliasNote);
    }

    return create(deps, facts, provenance, classification, 1, null);
  }

  // --- путь знаком, байты те же ----------------------------------------------
  if (current.sha256 === facts.sha256) {
    const { asset, changed } = await classifyAsset(deps.db, current.id, classification);
    return { status: 'already-registered', asset, classified: changed };
  }

  // --- путь знаком, байты другие ---------------------------------------------
  const byContent = await findAssetBySha256(deps.db, facts.sha256);

  if (byContent) {
    // Эти байты уже известны. Если под тем же путём — значит на диске лежит
    // содержимое устаревшей версии: кто-то откатил перерендер.
    if (byContent.relativePath === facts.relativePath) {
      return { status: 'older-version-on-disk', asset: byContent, currentAsset: current };
    }
    return conflictOrAlias(deps, byContent, facts.relativePath, options.aliasNote);
  }

  // Роль и персонаж наследуются у предыдущей версии, если импорт не сказал
  // иного: перерендеренный эталон Пуффа остаётся эталоном Пуффа, и заставлять
  // человека проставлять это заново значило бы терять уже принятое решение.
  const inherited: AssetClassification = {
    ...(current.role !== null ? { role: current.role } : {}),
    ...(current.cameraAngle !== null ? { cameraAngle: current.cameraAngle } : {}),
    ...(current.characterId !== null ? { characterId: current.characterId } : {}),
    ...classification
  };

  const created = await create(
    deps,
    facts,
    provenance,
    inherited,
    current.version + 1,
    current.id
  );

  return created.status === 'registered'
    ? { status: 'new-version', asset: created.asset, supersededAsset: current }
    : created;
}

/**
 * Найдена копия: сообщить о ней или записать как известное второе место.
 *
 * Решение принимает вызывающий, а не этот модуль. Без флага копия остаётся
 * поводом посмотреть глазами: одни и те же байты по двум путям бывают и
 * осознанным дублированием, и следом неудачной операции, а по самим байтам эти
 * случаи неразличимы.
 */
async function conflictOrAlias(
  deps: ImportDeps,
  asset: AssetView,
  requestedPath: string,
  aliasNote: string | null | undefined
): Promise<ImportOutcome> {
  if (aliasNote === undefined) {
    return { status: 'content-conflict', asset, requestedPath };
  }

  const { alreadyKnown } = await recordAssetAlias(
    deps.db,
    asset.id,
    requestedPath,
    aliasNote
  );

  return { status: 'alias-recorded', asset, aliasPath: requestedPath, alreadyKnown };
}

/**
 * Создание строки с разбором гонки.
 *
 * Между чтением и записью соседний процесс мог успеть всё что угодно, поэтому
 * нарушение уникального индекса разбирается по существу, а не превращается в
 * общий отказ. Разбор повторяет ту же логику, что и основной путь: иначе гонка
 * возвращала бы исход, отличающийся от спокойного случая, и отличие всплыло бы
 * в самый неудобный момент.
 */
async function create(
  deps: ImportDeps,
  facts: MediaFacts,
  provenance: ProvenanceDraft,
  classification: AssetClassification,
  version: number,
  supersedesId: string | null
): Promise<ImportOutcome> {
  try {
    const asset = await createAssetWithProvenance(deps.db, {
      relativePath: facts.relativePath,
      type: facts.type,
      mimeType: facts.mimeType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      width: facts.width,
      height: facts.height,
      role: classification.role ?? null,
      cameraAngle: classification.cameraAngle ?? null,
      characterId: classification.characterId ?? null,
      version,
      supersedesId,
      provenance
    });

    return { status: 'registered', asset };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    // Нарушить могло любое из трёх ограничений: sha256, путь+версия или
    // supersedesId. Первое разбираем по существу, остальные означают, что
    // соседний процесс уже занял этот номер версии.
    const byContent = await findAssetBySha256(deps.db, facts.sha256);
    if (byContent) {
      return byContent.relativePath === facts.relativePath
        ? { status: 'already-registered', asset: byContent, classified: false }
        : {
            status: 'content-conflict',
            asset: byContent,
            requestedPath: facts.relativePath
          };
    }

    throw new ConcurrentImportError(
      `Не удалось записать ${facts.relativePath}: пока шёл импорт, версию ` +
        `${version} по этому пути занял другой запуск. Повторите команду — ` +
        'ничего не потеряно и не перезаписано.'
    );
  }
}

/**
 * Зарегистрировать несколько файлов по очереди.
 *
 * Именно по очереди, а не параллельно: файлы по 26 МБ читаются целиком ради
 * отпечатка, и десяток одновременных потоков упёрся бы в диск, ничего не
 * ускорив.
 */
export async function importFiles(
  deps: ImportDeps,
  targets: readonly {
    relativePath: string;
    classification?: AssetClassification;
    aliasNote?: string | null;
  }[],
  provenance?: ProvenanceDraft
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const target of targets) {
    outcomes.push(
      await importFile(deps, target.relativePath, {
        ...(provenance ? { provenance } : {}),
        ...(target.classification ? { classification: target.classification } : {}),
        ...('aliasNote' in target ? { aliasNote: target.aliasNote } : {})
      })
    );
  }
  return outcomes;
}
