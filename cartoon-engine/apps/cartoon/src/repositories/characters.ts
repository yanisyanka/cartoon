/**
 * Доступ к персонажам. Prisma живёт только здесь и в соседнем файле про канон.
 */
import type { EngineDb } from '@core/index';
import type { CharacterFrequency, CharacterPassport } from '../domain/character-md';

export type CharacterView = {
  id: string;
  slug: string;
  number: number;
  name: string;
  nameRu: string;
  title: string;
  promptLine: string;
  colorAnchors: string[];
  heightRatio: number;
  frequency: CharacterFrequency;
  sourcePath: string;
  sourceSha256: string;
};

type CharacterRow = {
  id: string;
  slug: string;
  number: number;
  name: string;
  nameRu: string;
  title: string;
  promptLine: string;
  colorAnchors: string;
  heightRatio: number;
  frequency: string;
  sourcePath: string;
  sourceSha256: string;
};

export function toCharacterView(row: CharacterRow): CharacterView {
  return {
    id: row.id,
    slug: row.slug,
    number: row.number,
    name: row.name,
    nameRu: row.nameRu,
    title: row.title,
    promptLine: row.promptLine,
    colorAnchors: JSON.parse(row.colorAnchors) as string[],
    heightRatio: row.heightRatio,
    frequency: row.frequency as CharacterFrequency,
    sourcePath: row.sourcePath,
    sourceSha256: row.sourceSha256
  };
}

/**
 * Завести или обновить персонажа по slug.
 *
 * Upsert, а не create: паспорт правится (Твиглет уже перерендерен, у Пуффа
 * правка впереди), и повторный импорт обязан подхватывать изменения, не плодя
 * вторых персонажей. Ключ — slug: он же имя каталога, и переименование
 * каталога должно читаться как появление нового духа, а не как правка старого.
 *
 * Возвращается и то, изменилось ли что-нибудь: по этому признаку команда
 * отличает «канон разошёлся с базой» от «всё на месте».
 */
export async function upsertCharacter(
  db: EngineDb,
  passport: CharacterPassport
): Promise<{ character: CharacterView; created: boolean; updated: boolean }> {
  const data = {
    number: passport.number,
    name: passport.name,
    nameRu: passport.nameRu,
    title: passport.title,
    promptLine: passport.promptLine,
    colorAnchors: JSON.stringify(passport.colorAnchors),
    heightRatio: passport.heightRatio,
    frequency: passport.frequency,
    sourcePath: passport.sourcePath,
    sourceSha256: passport.sourceSha256
  };

  const existing = await db.character.findUnique({ where: { slug: passport.slug } });

  if (!existing) {
    const row = await db.character.create({ data: { slug: passport.slug, ...data } });
    return { character: toCharacterView(row), created: true, updated: false };
  }

  // Отпечаток паспорта — достаточный признак изменения: любая правка markdown
  // его меняет, а без правки он совпадает.
  const unchanged = existing.sourceSha256 === passport.sourceSha256;
  if (unchanged) {
    return { character: toCharacterView(existing), created: false, updated: false };
  }

  const row = await db.character.update({ where: { slug: passport.slug }, data });
  return { character: toCharacterView(row), created: false, updated: true };
}

export async function findCharacterBySlug(
  db: EngineDb,
  slug: string
): Promise<CharacterView | null> {
  const row = await db.character.findUnique({ where: { slug } });
  return row ? toCharacterView(row) : null;
}

export async function listCharacters(db: EngineDb): Promise<CharacterView[]> {
  const rows = await db.character.findMany({ orderBy: { number: 'asc' } });
  return rows.map(toCharacterView);
}

export async function countCharacters(db: EngineDb): Promise<number> {
  return db.character.count();
}
