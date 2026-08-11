/**
 * Проверка персонажей и канона: CE-TASK-002.
 *
 * Работает на настоящих паспортах, а не на образцах: смысл именно в том, чтобы
 * убедиться, что десять живых `character.md` читаются целиком и без потерь.
 *
 * Отдельно проверяется, что markdown после импорта не изменился. Команда его
 * только читает, но обещание — не доказательство, а отпечаток — доказательство.
 *
 *   npm run check:canon
 */
import 'dotenv/config';
import { getEngineDb, MediaStore } from '@core/index';
import { CANON_RULES } from '../apps/cartoon/src/domain/canon-rules';
import { FREQUENCIES } from '../apps/cartoon/src/domain/character-md';
import {
  countCharacters,
  listCharacters
} from '../apps/cartoon/src/repositories/characters';
import { countCanonRules, listCanonRules } from '../apps/cartoon/src/repositories/canon-rules';
import {
  CHARACTERS_DIR,
  PASSPORT_FILE,
  importCharacters
} from '../apps/cartoon/src/services/character-import';
import { importCanonRules } from '../apps/cartoon/src/services/canon-import';

const EXPECTED_CHARACTERS = 10;

const passed: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`Провалилась проверка: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
  passed.push(label);
}

async function main(): Promise<void> {
  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    console.log(`Корень медиа: ${store.rootPath}\n`);

    // --- паспорта на месте, отпечатки ДО ------------------------------------
    const passportPaths = await store.find(PASSPORT_FILE, CHARACTERS_DIR);
    check(
      `найдено ровно ${EXPECTED_CHARACTERS} паспортов`,
      passportPaths.length === EXPECTED_CHARACTERS,
      `найдено ${passportPaths.length}`
    );

    const before = new Map<string, string>();
    for (const relativePath of passportPaths) {
      const file = await store.readText(relativePath);
      before.set(file.relativePath, file.sha256);
    }

    // --- импорт персонажей ---------------------------------------------------
    const first = await importCharacters({ store, db });
    check(
      `импортировано ${EXPECTED_CHARACTERS} персонажей`,
      first.length === EXPECTED_CHARACTERS
    );
    check(
      'в базе ровно десять персонажей',
      (await countCharacters(db)) === EXPECTED_CHARACTERS
    );

    // --- идемпотентность -----------------------------------------------------
    const second = await importCharacters({ store, db });
    check(
      'повторный импорт не создал одиннадцатого персонажа',
      (await countCharacters(db)) === EXPECTED_CHARACTERS,
      `в базе ${await countCharacters(db)}`
    );
    check(
      'повторный импорт ничего не изменил',
      second.every((o) => o.status === 'unchanged'),
      second.map((o) => `${o.character.slug}:${o.status}`).join(', ')
    );

    // --- содержимое ----------------------------------------------------------
    const characters = await listCharacters(db);

    check(
      'номера идут подряд с 1 по 10',
      characters.map((c) => c.number).join(',') === '1,2,3,4,5,6,7,8,9,10'
    );
    check('slug уникальны', new Set(characters.map((c) => c.slug)).size === characters.length);

    for (const character of characters) {
      check(`строка промпта непуста: ${character.slug}`, character.promptLine.length > 20);
      check(
        `якорь есть и это HEX: ${character.slug}`,
        character.colorAnchors.length > 0 &&
          character.colorAnchors.every((hex) => /^#[0-9A-F]{6}$/.test(hex))
      );
      check(
        `рост положителен: ${character.slug}`,
        character.heightRatio > 0 && character.heightRatio < 10
      );
      check(
        `частота из известных: ${character.slug}`,
        (FREQUENCIES as readonly string[]).includes(character.frequency)
      );
      check(`должность непуста: ${character.slug}`, character.title.length > 0);
      check(`русское имя непусто: ${character.slug}`, character.nameRu.length > 0);
      check(
        `паспорт указан и существует: ${character.slug}`,
        character.sourcePath === `${CHARACTERS_DIR}/${character.slug}/${PASSPORT_FILE}` &&
          (await store.exists(character.sourcePath))
      );
      check(
        `отпечаток паспорта совпадает с файлом: ${character.slug}`,
        character.sourceSha256 === before.get(character.sourcePath),
        `в базе ${character.sourceSha256}, у файла ${before.get(character.sourcePath)}`
      );
    }

    // Канон требует различать рост: одинаковых значений быть не должно у всех,
    // но совпадения допустимы (1.0 у Москина, Глиммера и Эхо). Проверяем, что
    // разброс вообще есть, а не что все уникальны.
    check(
      'рост разведён: значений больше одного',
      new Set(characters.map((c) => c.heightRatio)).size > 1
    );

    // --- канон ---------------------------------------------------------------
    const rulesFirst = await importCanonRules(db);
    check(
      `импортировано ${CANON_RULES.length} правил канона`,
      rulesFirst.length === CANON_RULES.length
    );
    check(
      'в базе столько же правил, сколько в транскрипции',
      (await countCanonRules(db)) === CANON_RULES.length
    );

    const rulesSecond = await importCanonRules(db);
    check(
      'повторный импорт правил не создал дубликатов',
      (await countCanonRules(db)) === CANON_RULES.length
    );
    check(
      'повторный импорт правил ничего не изменил',
      rulesSecond.every((o) => o.status === 'unchanged')
    );

    const rules = await listCanonRules(db);
    for (const rule of rules) {
      check(`правило с описанием: ${rule.code}`, rule.description.length > 20);
      check(
        `правило со ссылкой на источник: ${rule.code}`,
        rule.source.includes('CAST.md')
      );
      check(
        `severity из известных: ${rule.code}`,
        rule.severity === 'blocking' || rule.severity === 'warning'
      );
    }

    // Правила, названные в задании явно, обязаны присутствовать.
    for (const code of [
      'color-anchor-red-belongs-to-fungi',
      'height-ratios-kept-distinct',
      'max-two-horned-in-frame',
      'silhouette-readable-at-100px',
      'face-canon-eyes',
      'face-canon-no-mouth',
      'no-cyrillic-in-generation'
    ]) {
      check(`правило на месте: ${code}`, rules.some((rule) => rule.code === code));
    }

    // --- markdown не изменился ----------------------------------------------
    for (const [relativePath, sha256] of before) {
      const file = await store.readText(relativePath);
      check(
        `паспорт не изменён импортом: ${relativePath}`,
        file.sha256 === sha256,
        `до: ${sha256}, после: ${file.sha256}`
      );
    }

    console.log(`Пройдено проверок: ${passed.length}`);
    console.log('check:canon — OK');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nПройдено до отказа: ${passed.length}`);
  console.error(`${name}: ${message}`);
  process.exitCode = 1;
});
