/**
 * Проверки импорта и версионирования на временной базе.
 *
 * База поднимается из тех же файлов миграций, что и рабочая: заодно
 * подтверждается, что миграции применимы по порядку. Схема накатывается
 * напрямую через better-sqlite3 — CLI Prisma здесь был бы медленнее и требовал
 * бы отдельной конфигурации ради одного временного файла.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { createEngineDb, type EngineDb } from '../packages/core/src/db';
import { MediaStore } from '../packages/core/src/media-store';
import { importFile } from '../packages/core/src/services/asset-import';
import {
  countAssets,
  listAssets,
  listCurrentAssets,
  listVersionsByPath
} from '../packages/core/src/repositories/assets';
import { InvariantError } from '../packages/core/src/errors';
import {
  createSandbox,
  JPEG_MINIMAL,
  PNG_1X1,
  PNG_1X1_BYTES,
  PNG_1X1_SHA256,
  type Sandbox
} from './fixtures';

const MIGRATIONS_DIR = path.resolve('prisma/migrations');

const MOSSY = 'characters/01-mossy/ref_front.png';

/** Другой валидный PNG: та же сигнатура, другое содержимое. */
const OTHER_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG_MINIMAL
]);

/** Третий вариант — для цепочки из трёх версий. */
const THIRD_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG_MINIMAL,
  Buffer.from([0x00, 0x01, 0x02])
]);

let sandbox: Sandbox;
let store: MediaStore;
let db: EngineDb;

/** Схема из настоящих файлов миграций, по порядку имён. */
async function migrationSql(): Promise<string> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(directories.length > 0, 'миграций нет — сначала npm run db:migrate');

  const parts: string[] = [];
  for (const directory of directories) {
    parts.push(
      await readFile(path.join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8')
    );
  }
  return parts.join('\n');
}

before(async () => {
  sandbox = await createSandbox();
  store = new MediaStore(sandbox.root);

  const dbPath = path.join(sandbox.root, 'test-engine.db');
  const raw = new Database(dbPath);
  raw.exec(await migrationSql());
  raw.close();

  db = createEngineDb(`file:${dbPath}`);
});

beforeEach(async () => {
  // Разом удалить нельзя, и это не неудобство, а работающая защита: на
  // supersedesId стоит onDelete: Restrict, поэтому база физически не позволяет
  // снести версию, на которую ссылается следующая. Историю приходится
  // разбирать с конца — сначала самые новые.
  const all = await db.asset.findMany({ orderBy: { version: 'desc' } });
  for (const asset of all) {
    await db.asset.delete({ where: { id: asset.id } });
  }
  await sandbox.put(MOSSY, PNG_1X1);
});

after(async () => {
  await db.$disconnect();
  await sandbox.dispose();
});

test('registered: первый импорт создаёт версию 1 с происхождением', async () => {
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'registered');
  assert.equal(outcome.asset.relativePath, MOSSY);
  assert.equal(outcome.asset.sha256, PNG_1X1_SHA256);
  assert.equal(outcome.asset.sizeBytes, PNG_1X1_BYTES);
  assert.equal(outcome.asset.version, 1);
  assert.equal(outcome.asset.supersedesId, null);
  assert.equal(outcome.asset.provenance?.producedBy, 'import');
  assert.equal(outcome.asset.provenance?.reproducibility, 'unknown');
  assert.equal(await countAssets(db), 1);
});

test('duplicate: тот же файл дважды — один ассет', async () => {
  const first = await importFile({ store, db }, MOSSY);
  const second = await importFile({ store, db }, MOSSY);

  assert.equal(first.status, 'registered');
  assert.equal(second.status, 'already-registered');
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(await countAssets(db), 1);
});

test('duplicate: те же байты по другому пути не создают вторую строку', async () => {
  const copy = 'characters/01-mossy/ref_front_copy.png';
  await sandbox.put(copy, PNG_1X1);

  await importFile({ store, db }, MOSSY);
  const outcome = await importFile({ store, db }, copy);

  assert.equal(outcome.status, 'content-conflict');
  assert.equal(await countAssets(db), 1);
});

// --- версионирование ---------------------------------------------------------

test('versioning: перерендер даёт новую версию, старая остаётся нетронутой', async () => {
  const first = await importFile({ store, db }, MOSSY);
  assert.equal(first.status, 'registered');
  const before = first.asset;

  // Файл перерендерили: путь прежний, содержимое другое.
  await sandbox.put(MOSSY, OTHER_PNG);
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'new-version');
  if (outcome.status !== 'new-version') return;

  // 4. старый Asset остаётся
  const versions = await listVersionsByPath(db, MOSSY);
  assert.equal(versions.length, 2);
  assert.equal(await countAssets(db), 2);

  const [older, newer] = versions;
  assert.ok(older && newer);

  // старая строка не изменилась ни в одном поле
  assert.equal(older.id, before.id);
  assert.equal(older.sha256, before.sha256);
  assert.equal(older.version, 1);
  assert.equal(older.supersedesId, null);
  assert.equal(older.createdAt, before.createdAt);

  // 5-6. новая запись ссылается на старую
  assert.equal(newer.id, outcome.asset.id);
  assert.equal(newer.version, 2);
  assert.equal(newer.supersedesId, older.id);
  assert.notEqual(newer.sha256, older.sha256);
  assert.equal(outcome.supersededAsset.id, older.id);

  // 7. оба происхождения сохранены
  assert.equal(older.provenance?.producedBy, 'import');
  assert.equal(older.provenance?.reproducibility, 'unknown');
  assert.equal(newer.provenance?.producedBy, 'import');
  assert.equal(newer.provenance?.reproducibility, 'unknown');
});

test('versioning: цепочка из трёх версий связна', async () => {
  await importFile({ store, db }, MOSSY);
  await sandbox.put(MOSSY, OTHER_PNG);
  await importFile({ store, db }, MOSSY);
  await sandbox.put(MOSSY, THIRD_PNG);
  await importFile({ store, db }, MOSSY);

  const versions = await listVersionsByPath(db, MOSSY);
  assert.deepEqual(
    versions.map((v) => v.version),
    [1, 2, 3]
  );
  assert.equal(versions[0]?.supersedesId, null);
  assert.equal(versions[1]?.supersedesId, versions[0]?.id);
  assert.equal(versions[2]?.supersedesId, versions[1]?.id);

  const current = await listCurrentAssets(db);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.version, 3);
});

test('versioning: роль и персонаж наследуются новой версией', async () => {
  await importFile({ store, db }, MOSSY, {
    classification: { role: 'ref-front' }
  });

  await sandbox.put(MOSSY, OTHER_PNG);
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'new-version');
  assert.equal(outcome.asset.role, 'ref-front');
});

test('versioning: откат к прежним байтам виден как расхождение с диском', async () => {
  await importFile({ store, db }, MOSSY);
  await sandbox.put(MOSSY, OTHER_PNG);
  await importFile({ store, db }, MOSSY);

  // Перерендер откатили — на диске снова содержимое версии 1.
  await sandbox.put(MOSSY, PNG_1X1);
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'older-version-on-disk');
  if (outcome.status === 'older-version-on-disk') {
    assert.equal(outcome.asset.version, 1);
    assert.equal(outcome.currentAsset.version, 2);
  }
  assert.equal(await countAssets(db), 2);
});

// --- классификация -----------------------------------------------------------

test('classify: роль проставляется существующей записи без новой строки', async () => {
  const first = await importFile({ store, db }, MOSSY);
  assert.equal(first.asset.role, null);

  const second = await importFile({ store, db }, MOSSY, {
    classification: { role: 'ref-front' }
  });

  assert.equal(second.status, 'already-registered');
  if (second.status === 'already-registered') assert.equal(second.classified, true);
  assert.equal(second.asset.role, 'ref-front');
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(await countAssets(db), 1);

  // Третий заход ничего не меняет — классификация идемпотентна.
  const third = await importFile({ store, db }, MOSSY, {
    classification: { role: 'ref-front' }
  });
  if (third.status === 'already-registered') assert.equal(third.classified, false);
});

test('classify: смена уже проставленной роли запрещена', async () => {
  await importFile({ store, db }, MOSSY, { classification: { role: 'ref-front' } });

  await assert.rejects(
    () => importFile({ store, db }, MOSSY, { classification: { role: 'plate' } }),
    InvariantError
  );

  const [asset] = await listAssets(db);
  assert.equal(asset?.role, 'ref-front');
});

// --- неизменность и отказы ---------------------------------------------------

test('immutable: импорт не меняет исходный файл', async () => {
  const absolute = path.join(sandbox.root, MOSSY);

  const before = createHash('sha256').update(await readFile(absolute)).digest('hex');
  await importFile({ store, db }, MOSSY);
  const after = createHash('sha256').update(await readFile(absolute)).digest('hex');

  assert.equal(before, PNG_1X1_SHA256);
  assert.equal(after, before);
});

test('provenance: несогласованное происхождение до базы не доходит', async () => {
  await assert.rejects(
    () =>
      importFile({ store, db }, MOSSY, {
        provenance: {
          producedBy: 'import',
          reproducibility: 'deterministic',
          note: null
        }
      }),
    InvariantError
  );

  assert.equal(await countAssets(db), 0);
});

test('missing: отсутствующий файл не создаёт строку', async () => {
  await assert.rejects(() => importFile({ store, db }, 'characters/99/ref_front.png'));

  assert.equal(await countAssets(db), 0);
});
