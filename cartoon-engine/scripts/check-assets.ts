/**
 * Проверка реестра ассетов: CE-TASK-001 + CE-TASK-002.
 *
 * Сети не касается и денег не тратит. Работает с настоящей базой и настоящими
 * файлами — иначе она не проверяла бы то, ради чего затевалась.
 *
 * Главное здесь — последняя проверка. Отпечатки всех десяти эталонов снимаются
 * ДО импорта и пересчитываются ПОСЛЕ. Совпадение — единственное машинное
 * доказательство того, что регистрация файлы не тронула. Все прочие обещания
 * («мы же только читаем») проверкой не являются.
 *
 * Персонажи должны быть импортированы заранее: эталон без персонажа не
 * регистрируется. Порядок задан в npm run check.
 *
 *   npm run check:assets
 */
import 'dotenv/config';
import {
  countAssets,
  getEngineDb,
  listCurrentAssets,
  MediaStore,
  needsAttention,
  type AssetView
} from '@core/index';
import { listCharacters } from '../apps/cartoon/src/repositories/characters';
import {
  importCharacterReferences,
  REFERENCE_FILE,
  REFERENCE_ROLE,
  slugFromReferencePath
} from '../apps/cartoon/src/services/reference-import';
import { CHARACTERS_DIR } from '../apps/cartoon/src/services/character-import';
import { isAssetRole } from '../apps/cartoon/src/domain/roles';

const EXPECTED_REFERENCES = 10;

const passed: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`Провалилась проверка: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
  passed.push(label);
}

type Fingerprint = { sha256: string; sizeBytes: number };

async function fingerprintAll(
  store: MediaStore,
  paths: readonly string[]
): Promise<Map<string, Fingerprint>> {
  const result = new Map<string, Fingerprint>();
  for (const relativePath of paths) {
    const facts = await store.describe(relativePath);
    result.set(facts.relativePath, {
      sha256: facts.sha256,
      sizeBytes: facts.sizeBytes
    });
  }
  return result;
}

async function main(): Promise<void> {
  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    console.log(`Корень медиа: ${store.rootPath}\n`);

    // --- предусловие ---------------------------------------------------------
    const characters = await listCharacters(db);
    check(
      `персонажи импортированы (${EXPECTED_REFERENCES})`,
      characters.length === EXPECTED_REFERENCES,
      `в базе ${characters.length}. Сначала: npm run check:canon`
    );
    const characterById = new Map(characters.map((c) => [c.id, c]));
    const characterBySlug = new Map(characters.map((c) => [c.slug, c]));

    // --- 1. файлы на месте ---------------------------------------------------
    const references = await store.find(REFERENCE_FILE, CHARACTERS_DIR);
    check(
      `найдено ровно ${EXPECTED_REFERENCES} файлов ${REFERENCE_FILE}`,
      references.length === EXPECTED_REFERENCES,
      `найдено ${references.length}`
    );

    // --- 2. отпечатки ДО импорта --------------------------------------------
    const before = await fingerprintAll(store, references);

    check(
      'у каждого файла посчитан sha256',
      [...before.values()].every((f) => /^[0-9a-f]{64}$/.test(f.sha256))
    );
    check(
      'отпечатки всех файлов различны',
      new Set([...before.values()].map((f) => f.sha256)).size === references.length
    );
    check('все размеры положительны', [...before.values()].every((f) => f.sizeBytes > 0));

    // --- 3. импорт -----------------------------------------------------------
    const countBefore = await countAssets(db);
    const first = await importCharacterReferences({ store, db });

    check(
      'импорт не сообщил о конфликтах',
      !first.some(needsAttention),
      first.filter(needsAttention).map((o) => o.status).join(', ')
    );

    const newRows = first.filter(
      (o) => o.status === 'registered' || o.status === 'new-version'
    ).length;
    const countAfterFirst = await countAssets(db);

    check(
      'число строк выросло ровно на число новых записей',
      countAfterFirst === countBefore + newRows,
      `было ${countBefore}, стало ${countAfterFirst}, новых ${newRows}`
    );

    // --- 4. повторный импорт не создаёт дубликатов ---------------------------
    const second = await importCharacterReferences({ store, db });
    const countAfterSecond = await countAssets(db);

    check(
      'повторный импорт не создал ни одной строки',
      countAfterSecond === countAfterFirst,
      `было ${countAfterFirst}, стало ${countAfterSecond}`
    );
    check(
      'повторный импорт опознал все файлы как уже зарегистрированные',
      second.every((o) => o.status === 'already-registered'),
      second.map((o) => o.status).join(', ')
    );
    check(
      'повторный импорт ничего не доклассифицировал',
      second.every((o) => o.status === 'already-registered' && !o.classified)
    );

    // --- 5. содержимое реестра ----------------------------------------------
    const current = await listCurrentAssets(db);
    const byPath = new Map<string, AssetView>(current.map((a) => [a.relativePath, a]));

    for (const relativePath of references) {
      const expected = before.get(relativePath);
      const asset = byPath.get(relativePath);

      check(`зарегистрирован: ${relativePath}`, asset !== undefined);
      if (!asset || !expected) continue;

      check(
        `sha256 в базе совпадает с файлом: ${relativePath}`,
        asset.sha256 === expected.sha256
      );
      check(
        `размер в базе совпадает с файлом: ${relativePath}`,
        asset.sizeBytes === expected.sizeBytes
      );
      check(
        `relativePath корректен: ${relativePath}`,
        !asset.relativePath.startsWith('/') &&
          !/^[a-zA-Z]:/.test(asset.relativePath) &&
          !asset.relativePath.includes('\\') &&
          !asset.relativePath.includes('..')
      );
      check(
        `путь из базы разрешается в существующий файл: ${relativePath}`,
        await store.exists(asset.relativePath)
      );
      check(`тип определён как image: ${relativePath}`, asset.type === 'image');
      check(
        `mimeType определён по содержимому: ${relativePath}`,
        asset.mimeType === 'image/png'
      );
      check(
        `producedBy = import: ${relativePath}`,
        asset.provenance?.producedBy === 'import',
        `получено ${asset.provenance?.producedBy}`
      );
      check(
        `reproducibility = unknown: ${relativePath}`,
        asset.provenance?.reproducibility === 'unknown',
        `получено ${asset.provenance?.reproducibility}`
      );

      // --- новое в CE-TASK-002 ---
      check(
        `role = ${REFERENCE_ROLE}: ${relativePath}`,
        asset.role === REFERENCE_ROLE,
        `получено ${asset.role}`
      );
      check(
        `роль из известного словаря: ${relativePath}`,
        asset.role !== null && isAssetRole(asset.role)
      );
      check(`version = 1: ${relativePath}`, asset.version === 1);
      check(`первая версия ни на что не ссылается: ${relativePath}`, asset.supersedesId === null);

      const slug = slugFromReferencePath(relativePath);
      const expectedCharacter = characterBySlug.get(slug);
      check(
        `привязан к персонажу ${slug}: ${relativePath}`,
        asset.characterId !== null && asset.characterId === expectedCharacter?.id,
        `в базе characterId=${asset.characterId}, ожидался ${expectedCharacter?.id}`
      );
      check(
        `персонаж существует и это ${slug}: ${relativePath}`,
        asset.characterId !== null && characterById.get(asset.characterId)?.slug === slug
      );
    }

    check(
      'у каждого персонажа ровно один текущий эталон',
      characters.every(
        (character) =>
          current.filter(
            (asset) => asset.characterId === character.id && asset.role === REFERENCE_ROLE
          ).length === 1
      )
    );

    // --- 6. файлы не изменились ---------------------------------------------
    const after = await fingerprintAll(store, references);

    check('после импорта на месте всё те же файлы', after.size === before.size);

    for (const [relativePath, expected] of before) {
      const actual = after.get(relativePath);
      check(
        `файл не изменился: ${relativePath}`,
        actual !== undefined &&
          actual.sha256 === expected.sha256 &&
          actual.sizeBytes === expected.sizeBytes,
        `до: ${expected.sha256}, после: ${actual?.sha256}`
      );
    }

    console.log(`Пройдено проверок: ${passed.length}`);
    console.log('check:assets — OK');
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
