/**
 * Проверка реестра ассетов: CE-TASK-001 … 003A.
 *
 * Сети не касается, денег не тратит, генеративных моделей не запускает.
 * Работает с настоящей базой и настоящими файлами — иначе она не проверяла бы
 * то, ради чего затевалась.
 *
 * Главное здесь — последняя проверка. Отпечатки ВСЕХ медиафайлов снимаются до
 * импорта и пересчитываются после. Совпадение — единственное машинное
 * доказательство того, что регистрация файлы не тронула. Все прочие обещания
 * («мы же только читаем») проверкой не являются.
 *
 * Персонажи должны быть импортированы заранее. Порядок задан в npm run check.
 *
 *   npm run check:assets
 */
import 'dotenv/config';
import {
  countAssetAliases,
  countAssets,
  getEngineDb,
  listAssetAliases,
  listCurrentAssets,
  MediaStore,
  type AssetView
} from '@core/index';
import { listCharacters } from '../apps/cartoon/src/repositories/characters';
import {
  ARCHIVE_DIR,
  importArchive,
  importCharacterAssets
} from '../apps/cartoon/src/services/character-assets-import';
import { CHARACTERS_DIR } from '../apps/cartoon/src/services/character-import';
import { isAssetRole } from '../apps/cartoon/src/domain/roles';
import { MEDIA_EXTENSIONS } from '../apps/cartoon/src/services/inventory';

const EXPECTED_CHARACTERS = 10;
/** Десять папок по три файла: эталон, карточка, клип. */
const EXPECTED_CHARACTER_ASSETS = 30;
/** Замер архива: 28 файлов побайтово совпадают с папками персонажей. */
const EXPECTED_ALIASES = 28;
/** Остальные архивные файлы регистрируются без роли и без персонажа. */
const EXPECTED_ARCHIVE_ASSETS = 10;
const EXPECTED_MEDIA_FILES = 68;

const ARCHIVE_NOTE = 'оригинал, из которого материал копировался в папку персонажа';

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
    result.set(facts.relativePath, { sha256: facts.sha256, sizeBytes: facts.sizeBytes });
  }
  return result;
}

function isMedia(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return MEDIA_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function main(): Promise<void> {
  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    console.log(`Корень медиа: ${store.rootPath}\n`);

    // --- предусловие ---------------------------------------------------------
    const characters = await listCharacters(db);
    check(
      `персонажи импортированы (${EXPECTED_CHARACTERS})`,
      characters.length === EXPECTED_CHARACTERS,
      `в базе ${characters.length}. Сначала: npm run check:canon`
    );
    const characterById = new Map(characters.map((c) => [c.id, c]));
    const characterBySlug = new Map(characters.map((c) => [c.slug, c]));

    // --- 1. файлы на месте, отпечатки ДО -------------------------------------
    //
    // Считаются только те файлы, что существовали до движка. Всё, что движок
    // произвёл сам, из этого счёта исключается: иначе каждая генерация ломала
    // бы проверку неизменности исходников, хотя исходников она не касается.
    const produced = new Set(
      (await listCurrentAssets(db))
        .filter((asset) => asset.provenance?.producedBy === 'provider')
        .map((asset) => asset.relativePath)
    );

    const allMedia = (await store.findAll(CHARACTERS_DIR))
      .filter(isMedia)
      .filter((relativePath) => !produced.has(relativePath));

    check(
      `исходных медиафайлов по-прежнему ${EXPECTED_MEDIA_FILES}`,
      allMedia.length === EXPECTED_MEDIA_FILES,
      `найдено ${allMedia.length}, произведено движком ${produced.size}`
    );

    const before = await fingerprintAll(store, allMedia);
    check(
      'у каждого файла посчитан sha256',
      [...before.values()].every((f) => /^[0-9a-f]{64}$/.test(f.sha256))
    );
    check('все размеры положительны', [...before.values()].every((f) => f.sizeBytes > 0));

    // --- 2. импорт материала персонажей --------------------------------------
    const first = await importCharacterAssets({ store, db });
    check(
      `обработано ${EXPECTED_CHARACTER_ASSETS} файлов персонажей`,
      first.length === EXPECTED_CHARACTER_ASSETS,
      `обработано ${first.length}`
    );
    check(
      'все файлы персонажей опознаны по содержимому',
      first.every((r) => r.unclassifiedReason === null),
      first
        .filter((r) => r.unclassifiedReason)
        .map((r) => `${r.relativePath}: ${r.unclassifiedReason}`)
        .join('; ')
    );

    // --- 3. архив ------------------------------------------------------------
    await importArchive({ store, db }, ARCHIVE_DIR, ARCHIVE_NOTE);

    const aliasCount = await countAssetAliases(db);
    check(
      `псевдонимов ровно ${EXPECTED_ALIASES}`,
      aliasCount === EXPECTED_ALIASES,
      `в базе ${aliasCount}`
    );

    const totalAssets = await countAssets(db);
    const importedCount = (await listCurrentAssets(db)).filter(
      (asset) => asset.provenance?.producedBy === 'import'
    ).length;

    check(
      `импортированных ассетов ровно ${EXPECTED_CHARACTER_ASSETS + EXPECTED_ARCHIVE_ASSETS}`,
      importedCount === EXPECTED_CHARACTER_ASSETS + EXPECTED_ARCHIVE_ASSETS,
      `в базе ${importedCount} импортированных из ${totalAssets} всего`
    );

    // --- 4. идемпотентность --------------------------------------------------
    const secondCharacters = await importCharacterAssets({ store, db });
    await importArchive({ store, db }, ARCHIVE_DIR, ARCHIVE_NOTE);

    check(
      'повторный импорт не создал ни одного ассета',
      (await countAssets(db)) === totalAssets,
      `было ${totalAssets}, стало ${await countAssets(db)}`
    );
    check(
      'повторный импорт не создал ни одного псевдонима',
      (await countAssetAliases(db)) === aliasCount
    );
    check(
      'повторный импорт ничего не доклассифицировал',
      secondCharacters.every(
        (r) => r.outcome?.status === 'already-registered' && !r.outcome.classified
      )
    );

    // --- 5. содержимое реестра ----------------------------------------------
    const current = await listCurrentAssets(db);
    const byPath = new Map<string, AssetView>(current.map((a) => [a.relativePath, a]));

    const expectedRoles: Record<string, string> = {
      'ref_front.png': 'ref-front',
      'card.jpg': 'card',
      'clip.mp4': 'clip'
    };

    for (const character of characters) {
      for (const [fileName, role] of Object.entries(expectedRoles)) {
        const relativePath = `${CHARACTERS_DIR}/${character.slug}/${fileName}`;
        const asset = byPath.get(relativePath);
        const expected = before.get(relativePath);

        check(`зарегистрирован: ${relativePath}`, asset !== undefined);
        if (!asset || !expected) continue;

        check(`sha256 совпадает: ${relativePath}`, asset.sha256 === expected.sha256);
        check(`размер совпадает: ${relativePath}`, asset.sizeBytes === expected.sizeBytes);
        check(
          `relativePath корректен: ${relativePath}`,
          !asset.relativePath.startsWith('/') &&
            !/^[a-zA-Z]:/.test(asset.relativePath) &&
            !asset.relativePath.includes('\\') &&
            !asset.relativePath.includes('..')
        );
        check(
          `путь разрешается в существующий файл: ${relativePath}`,
          await store.exists(asset.relativePath)
        );
        check(`role = ${role}: ${relativePath}`, asset.role === role, `получено ${asset.role}`);
        check(
          `роль из словаря: ${relativePath}`,
          asset.role !== null && isAssetRole(asset.role)
        );
        check(`version = 1: ${relativePath}`, asset.version === 1);
        check(
          `привязан к ${character.slug}: ${relativePath}`,
          asset.characterId === character.id
        );
        check(
          `персонаж тот самый: ${relativePath}`,
          asset.characterId !== null &&
            characterById.get(asset.characterId)?.slug === character.slug
        );
        check(
          `producedBy = import: ${relativePath}`,
          asset.provenance?.producedBy === 'import'
        );
        check(
          `reproducibility = unknown: ${relativePath}`,
          asset.provenance?.reproducibility === 'unknown'
        );
      }
    }

    check(
      'у каждого персонажа ровно один эталон, одна карточка и один клип',
      characters.every((character) =>
        ['ref-front', 'card', 'clip'].every(
          (role) =>
            current.filter((a) => a.characterId === character.id && a.role === role).length === 1
        )
      )
    );

    // --- 6. архивные ассеты не получили выдуманных ролей ---------------------
    const archived = current.filter((a) => a.relativePath.startsWith(`${ARCHIVE_DIR}/`));
    check(
      `архивных ассетов ${EXPECTED_ARCHIVE_ASSETS}`,
      archived.length === EXPECTED_ARCHIVE_ASSETS,
      `найдено ${archived.length}`
    );
    check(
      'ни один архивный ассет не получил роли',
      archived.every((a) => a.role === null),
      archived.filter((a) => a.role).map((a) => `${a.relativePath}=${a.role}`).join(', ')
    );
    check(
      'ни один архивный ассет не привязан к персонажу',
      archived.every((a) => a.characterId === null)
    );
    check(
      'происхождение архивных — import/unknown',
      archived.every(
        (a) =>
          a.provenance?.producedBy === 'import' &&
          a.provenance.reproducibility === 'unknown'
      )
    );

    // --- 7. псевдонимы указывают на настоящие ассеты -------------------------
    const aliases = await listAssetAliases(db);
    const assetIds = new Set(current.map((a) => a.id));
    check(
      'каждый псевдоним указывает на существующий ассет',
      aliases.every((alias) => assetIds.has(alias.assetId))
    );
    check(
      'путь псевдонима существует на диске',
      (await Promise.all(aliases.map((alias) => store.exists(alias.relativePath)))).every(Boolean)
    );
    check(
      'ни один путь не является одновременно ассетом и псевдонимом',
      aliases.every((alias) => !byPath.has(alias.relativePath))
    );

    // --- 8. файлы не изменились ---------------------------------------------
    const after = await fingerprintAll(store, allMedia);
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
