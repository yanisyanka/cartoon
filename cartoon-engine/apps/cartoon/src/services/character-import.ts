/**
 * Импорт персонажей из паспортов.
 *
 * Markdown только читается. Ни строчки в `character.md` эта команда не меняет —
 * канон правит человек, движок его отражает.
 */
import { InvariantError, type EngineDb, type MediaStore } from '@core/index';
import { parseCharacterPassport } from '../domain/character-md';
import { upsertCharacter, type CharacterView } from '../repositories/characters';

export const PASSPORT_FILE = 'character.md';
export const CHARACTERS_DIR = 'characters';

export type CharacterImportOutcome = {
  character: CharacterView;
  status: 'created' | 'updated' | 'unchanged';
};

/** Каталог персонажа из пути паспорта: 'characters/01-mossy/character.md' → '01-mossy'. */
export function slugFromPassportPath(relativePath: string): string {
  const parts = relativePath.split('/');
  const slug = parts.at(-2);

  if (parts.at(-1) !== PASSPORT_FILE || parts.at(-3) !== CHARACTERS_DIR || !slug) {
    throw new InvariantError(
      `Паспорт ожидается по пути ${CHARACTERS_DIR}/<slug>/${PASSPORT_FILE}, ` +
        `а найден как ${relativePath}.`
    );
  }

  return slug;
}

export async function importCharacters(deps: {
  store: MediaStore;
  db: EngineDb;
}): Promise<CharacterImportOutcome[]> {
  const passportPaths = await deps.store.find(PASSPORT_FILE, CHARACTERS_DIR);

  const outcomes: CharacterImportOutcome[] = [];
  for (const relativePath of passportPaths) {
    const slug = slugFromPassportPath(relativePath);
    const file = await deps.store.readText(relativePath);

    const passport = parseCharacterPassport({
      markdown: file.text,
      slug,
      sourcePath: file.relativePath,
      sourceSha256: file.sha256
    });

    const { character, created, updated } = await upsertCharacter(deps.db, passport);
    outcomes.push({
      character,
      status: created ? 'created' : updated ? 'updated' : 'unchanged'
    });
  }

  return outcomes;
}
