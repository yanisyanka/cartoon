/**
 * Импорт эталонов персонажей с классификацией.
 *
 * Единственное место, где путь превращается в смысл: `characters/01-mossy/
 * ref_front.png` — это фронтальный эталон Москина. Правило живёт здесь, а не в
 * ядре: ядро знает, что у ассета бывает роль, но не знает, что такое эталон.
 */
import {
  importFiles,
  type EngineDb,
  type ImportOutcome,
  type MediaStore
} from '@core/index';
import { InvariantError } from '@core/index';
import { assertAssetRole } from '../domain/roles';
import { listCharacters } from '../repositories/characters';
import { CHARACTERS_DIR } from './character-import';

export const REFERENCE_FILE = 'ref_front.png';
export const REFERENCE_ROLE = 'ref-front';

/** Каталог персонажа из пути эталона. */
export function slugFromReferencePath(relativePath: string): string {
  const parts = relativePath.split('/');
  const slug = parts.at(-2);

  if (parts.at(-1) !== REFERENCE_FILE || parts.at(-3) !== CHARACTERS_DIR || !slug) {
    throw new InvariantError(
      `Эталон ожидается по пути ${CHARACTERS_DIR}/<slug>/${REFERENCE_FILE}, ` +
        `а найден как ${relativePath}.`
    );
  }

  return slug;
}

/**
 * Зарегистрировать все эталоны, привязав каждый к своему персонажу.
 *
 * Персонажи должны быть импортированы заранее. Эталон без персонажа не
 * регистрируется вовсе: файл, про который неизвестно, кто на нём, — это ровно
 * тот пробел, ради закрытия которого задача и делается.
 */
export async function importCharacterReferences(deps: {
  store: MediaStore;
  db: EngineDb;
}): Promise<ImportOutcome[]> {
  assertAssetRole(REFERENCE_ROLE);

  const characters = await listCharacters(deps.db);
  const bySlug = new Map(characters.map((character) => [character.slug, character]));

  if (bySlug.size === 0) {
    throw new InvariantError(
      'В базе нет ни одного персонажа. Сначала: cartoon characters import.'
    );
  }

  const referencePaths = await deps.store.find(REFERENCE_FILE, CHARACTERS_DIR);

  const targets = referencePaths.map((relativePath) => {
    const slug = slugFromReferencePath(relativePath);
    const character = bySlug.get(slug);

    if (!character) {
      throw new InvariantError(
        `Эталон ${relativePath} лежит в каталоге ${slug}, а персонажа с таким ` +
          'slug в базе нет. Либо паспорт не импортирован, либо каталог лишний.'
      );
    }

    return {
      relativePath,
      classification: { role: REFERENCE_ROLE, characterId: character.id }
    };
  });

  return importFiles({ store: deps.store, db: deps.db }, targets);
}
