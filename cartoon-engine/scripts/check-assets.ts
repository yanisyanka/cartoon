/**
 * Проверка фундамента ассетов: CE-TASK-001.
 *
 * Сети не касается и денег не тратит. Работает с настоящей базой и настоящими
 * файлами — иначе она не проверяла бы то, ради чего затевалась.
 *
 * Главное здесь — девятая проверка. Отпечатки всех десяти эталонов снимаются
 * ДО импорта и пересчитываются ПОСЛЕ. Совпадение — единственное машинное
 * доказательство того, что регистрация файлы не тронула. Все прочие обещания
 * («мы же только читаем») проверкой не являются.
 *
 *   npm run check:assets
 */
import 'dotenv/config';
import {
  countAssets,
  getEngineDb,
  importFiles,
  listAssets,
  MediaStore,
  type AssetView
} from '@core/index';

const EXPECTED_REFERENCES = 10;
const REFERENCE_FILE = 'ref_front.png';
const CHARACTERS_DIR = 'characters';

const passed: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`Провалилась проверка: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
  passed.push(label);
}

/** Отпечаток файла в том виде, в каком его снимают до и после импорта. */
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

    // --- 1. файлы на месте ---------------------------------------------------
    const references = await store.find(REFERENCE_FILE, CHARACTERS_DIR);

    check(
      `найдено ровно ${EXPECTED_REFERENCES} файлов ${REFERENCE_FILE}`,
      references.length === EXPECTED_REFERENCES,
      `найдено ${references.length}: ${references.join(', ')}`
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

    check(
      'все размеры положительны',
      [...before.values()].every((f) => f.sizeBytes > 0)
    );

    // --- 3. импорт -----------------------------------------------------------
    const countBefore = await countAssets(db);
    const first = await importFiles({ store, db }, references);

    check(
      'импорт не сообщил о конфликтах',
      first.every((o) => o.status === 'registered' || o.status === 'already-registered'),
      first
        .filter((o) => o.status === 'content-conflict' || o.status === 'content-changed')
        .map((o) => o.status)
        .join(', ')
    );

    const countAfterFirst = await countAssets(db);
    const newlyRegistered = first.filter((o) => o.status === 'registered').length;

    check(
      'число строк выросло ровно на число впервые увиденных файлов',
      countAfterFirst === countBefore + newlyRegistered,
      `было ${countBefore}, стало ${countAfterFirst}, впервые увидено ${newlyRegistered}`
    );

    // --- 4. повторный импорт не создаёт дубликатов ---------------------------
    const second = await importFiles({ store, db }, references);
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

    // --- 5. содержимое реестра ----------------------------------------------
    const registered = await listAssets(db);
    const byPath = new Map<string, AssetView>(
      registered.map((asset) => [asset.relativePath, asset])
    );

    for (const relativePath of references) {
      const expected = before.get(relativePath);
      const asset = byPath.get(relativePath);

      check(`зарегистрирован: ${relativePath}`, asset !== undefined);
      if (!asset || !expected) continue;

      check(
        `sha256 в базе совпадает с файлом: ${relativePath}`,
        asset.sha256 === expected.sha256,
        `в базе ${asset.sha256}, у файла ${expected.sha256}`
      );

      check(
        `размер в базе совпадает с файлом: ${relativePath}`,
        asset.sizeBytes === expected.sizeBytes,
        `в базе ${asset.sizeBytes}, у файла ${expected.sizeBytes}`
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
    }

    // --- 6. файлы не изменились ---------------------------------------------
    //
    // Ради этой проверки всё и затевалось: отпечатки пересчитываются заново, с
    // диска, и сравниваются с теми, что были сняты до импорта.
    const after = await fingerprintAll(store, references);

    check(
      'после импорта на месте всё те же файлы',
      after.size === before.size
    );

    for (const [relativePath, expected] of before) {
      const actual = after.get(relativePath);
      check(
        `файл не изменился: ${relativePath}`,
        actual !== undefined &&
          actual.sha256 === expected.sha256 &&
          actual.sizeBytes === expected.sizeBytes,
        `до: ${expected.sha256} (${expected.sizeBytes} б), ` +
          `после: ${actual?.sha256} (${actual?.sizeBytes} б)`
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
