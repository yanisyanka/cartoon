/**
 * Правила регистрации файла в реестре.
 *
 * Порядок шагов важен и повторяет порядок из соседнего проекта: сначала факты о
 * файле, потом поиск уже известного, и только потом запись. Ничего не пишется
 * до того, как файл прочитан целиком, — иначе оборванное чтение оставило бы
 * строку с отпечатком, которому нечего соответствовать.
 *
 * Файл здесь только читается. Ни перемещения, ни копирования, ни переименования
 * в этом модуле нет и быть не может: реестр описывает дерево, а не управляет им.
 */
import type { ImportOutcome } from '../asset';
import type { EngineDb } from '../db';
import type { MediaStore } from '../media-store';
import { assertValidProvenance, importedProvenance } from '../provenance';
import type { ProvenanceDraft } from '../provenance';
import {
  createAssetWithProvenance,
  findAssetByPath,
  findAssetBySha256,
  isUniqueConstraintError
} from '../repositories/assets';

export type ImportDeps = {
  store: MediaStore;
  db: EngineDb;
};

/**
 * Зарегистрировать файл.
 *
 * Дедупликация идёт по sha256, а не по пути. Причина в том, что путь — это
 * место, а отпечаток — сам файл: переименованный эталон остаётся тем же
 * эталоном, а два разных рендера по одному пути одним файлом не становятся.
 *
 * Происхождение по умолчанию — импорт, то есть unknown. Передать другое можно,
 * но не любое: assertValidProvenance не пропустит импорт, объявленный
 * воспроизводимым.
 */
export async function importFile(
  deps: ImportDeps,
  relativePath: string,
  provenance: ProvenanceDraft = importedProvenance()
): Promise<ImportOutcome> {
  assertValidProvenance(provenance);

  const facts = await deps.store.describe(relativePath);

  const byContent = await findAssetBySha256(deps.db, facts.sha256);
  if (byContent) {
    return byContent.relativePath === facts.relativePath
      ? { status: 'already-registered', asset: byContent }
      : {
          status: 'content-conflict',
          asset: byContent,
          requestedPath: facts.relativePath
        };
  }

  // Отпечаток новый, но путь может быть занят: значит файл по этому пути
  // переделали. Создавать вторую строку нельзя, и молча падать на уникальном
  // индексе — тоже: человеку нужно знать, что именно разошлось.
  const byPath = await findAssetByPath(deps.db, facts.relativePath);
  if (byPath) {
    return {
      status: 'content-changed',
      asset: byPath,
      currentSha256: facts.sha256
    };
  }

  try {
    const asset = await createAssetWithProvenance(deps.db, {
      relativePath: facts.relativePath,
      type: facts.type,
      mimeType: facts.mimeType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      provenance
    });

    return { status: 'registered', asset };
  } catch (error) {
    // Гонка двух одновременных запусков: строку успел создать соседний вызов.
    // Данные должны остаться согласованными, а исход — правдивым.
    if (isUniqueConstraintError(error)) {
      const existing = await findAssetBySha256(deps.db, facts.sha256);
      if (existing) return { status: 'already-registered', asset: existing };
    }
    throw error;
  }
}

/**
 * Зарегистрировать несколько файлов по очереди.
 *
 * Именно по очереди, а не параллельно: файлы по 26 МБ читаются целиком ради
 * отпечатка, и десяток одновременных потоков упёрся бы в диск, ничего не
 * ускорив. Отказ на одном файле останавливает всё — половина импортированного
 * набора хуже, чем ничего, потому что о ней потом надо помнить.
 */
export async function importFiles(
  deps: ImportDeps,
  relativePaths: readonly string[],
  provenance: ProvenanceDraft = importedProvenance()
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const relativePath of relativePaths) {
    outcomes.push(await importFile(deps, relativePath, provenance));
  }
  return outcomes;
}
