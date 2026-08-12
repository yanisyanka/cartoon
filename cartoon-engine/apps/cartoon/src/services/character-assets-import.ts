/**
 * Импорт существующих файлов проекта с опознанием по содержимому.
 *
 * Два разных случая, и смешивать их нельзя.
 *
 * Папки персонажей — материал, с которым работают: у каждого файла есть роль и
 * владелец, и то и другое подтверждается измерением кадра.
 *
 * `MOSS KIN-лесные духи/` — архив оригиналов, из которых материал копировался
 * (по СТАТУС.md копировался намеренно, чтобы не сломать ссылки в проекте
 * Premiere). Большинство файлов там побайтово совпадает с папками персонажей и
 * становится псевдонимами; остальные регистрируются как есть, без роли и без
 * персонажа, потому что определить их автоматически нельзя.
 */
import {
  importFile,
  InvariantError,
  type EngineDb,
  type ImportOutcome,
  type MediaStore
} from '@core/index';
import { classifyCharacterAsset } from '../domain/character-assets';
import { probeVideo, type VideoFacts } from '../domain/video-probe';
import { assertAssetRole } from '../domain/roles';
import { listCharacters } from '../repositories/characters';
import { MEDIA_EXTENSIONS } from './inventory';
import { CHARACTERS_DIR } from './character-import';

export { CHARACTERS_DIR };
export const ARCHIVE_DIR = 'characters/MOSS KIN-лесные духи';
export const REFERENCE_FILE = 'ref_front.png';
export const REFERENCE_ROLE = 'ref-front';

/** Что удалось и что не удалось опознать. */
export type ClassifiedImport = {
  relativePath: string;
  outcome: ImportOutcome | null;
  /** Почему роль не назначена. null — назначена. */
  unclassifiedReason: string | null;
};

function isMedia(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return MEDIA_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function videoFactsFor(
  store: MediaStore,
  relativePath: string,
  isVideo: boolean
): Promise<VideoFacts | null> {
  if (!isVideo) return null;
  const facts = await store.describe(relativePath);
  const probe = await probeVideo(facts.absolutePath);
  return probe.ok ? probe.facts : null;
}

/**
 * Зарегистрировать материал папок персонажей.
 *
 * Файл, чью роль содержимое не подтвердило, регистрируется БЕЗ роли, а не с
 * выдуманной. Пропустить его тоже нельзя: тогда реестр молчал бы о файле,
 * который на диске есть.
 */
export async function importCharacterAssets(deps: {
  store: MediaStore;
  db: EngineDb;
}): Promise<ClassifiedImport[]> {
  const characters = await listCharacters(deps.db);
  if (characters.length === 0) {
    throw new InvariantError(
      'В базе нет ни одного персонажа. Сначала: cartoon characters import.'
    );
  }

  const bySlug = new Map(characters.map((character) => [character.slug, character]));
  const slugs = new Set(bySlug.keys());

  // Только прямые подпапки персонажей: архив разбирается отдельной командой.
  const candidates = (await deps.store.findAll(CHARACTERS_DIR))
    .filter(isMedia)
    .filter((relativePath) => {
      const parts = relativePath.split('/');
      return parts.length === 3 && slugs.has(parts[1] as string);
    });

  const results: ClassifiedImport[] = [];

  for (const relativePath of candidates) {
    const facts = await deps.store.describe(relativePath);
    const video = await videoFactsFor(deps.store, relativePath, facts.type === 'video');
    const classification = classifyCharacterAsset(relativePath, facts, video, slugs);

    if (classification.role === null) {
      const outcome = await importFile(deps, relativePath);
      results.push({
        relativePath,
        outcome,
        unclassifiedReason: classification.reason
      });
      continue;
    }

    assertAssetRole(classification.role);
    const character = bySlug.get(classification.slug);
    if (!character) {
      throw new InvariantError(`Персонаж ${classification.slug} исчез между чтением и записью.`);
    }

    const outcome = await importFile(deps, relativePath, {
      classification: { role: classification.role, characterId: character.id }
    });
    results.push({ relativePath, outcome, unclassifiedReason: null });
  }

  return results;
}

/**
 * Разобрать архив оригиналов.
 *
 * Файлы, чьи байты уже известны, записываются псевдонимами — вторыми местами
 * тех же ассетов. Остальные регистрируются без роли и без персонажа: имя
 * «Твиглет.png» указывает на персонажа, но содержимое у этого файла другого
 * формата (2134×3297 против 3584×4800 у эталона), и привязать его по имени
 * значило бы принять догадку за факт.
 */
export async function importArchive(
  deps: { store: MediaStore; db: EngineDb },
  archiveDir: string,
  aliasNote: string
): Promise<ClassifiedImport[]> {
  const candidates = (await deps.store.findAll(archiveDir)).filter(isMedia);
  const results: ClassifiedImport[] = [];

  for (const relativePath of candidates) {
    const outcome = await importFile(deps, relativePath, { aliasNote });
    results.push({
      relativePath,
      outcome,
      unclassifiedReason:
        outcome.status === 'registered'
          ? 'архивный файл: роль и персонаж автоматически не определяются'
          : null
    });
  }

  return results;
}
