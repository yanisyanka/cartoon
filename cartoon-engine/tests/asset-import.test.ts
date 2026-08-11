/**
 * Проверки импорта на временной базе.
 *
 * База поднимается из тех же файлов миграций, что и рабочая: заодно
 * подтверждается, что миграция вообще применима. Схема накатывается напрямую
 * через better-sqlite3 — CLI Prisma здесь был бы медленнее и требовал бы
 * отдельной конфигурации ради одного временного файла.
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
import { countAssets, listAssets } from '../packages/core/src/repositories/assets';
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

/**
 * Другой валидный PNG: та же сигнатура, другое содержимое.
 * Нужен, чтобы смоделировать «файл перерендерили», а не «файл подменили на
 * чужой формат» — второе отсекается ещё сверкой расширения.
 */
const OTHER_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG_MINIMAL
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
  // Каждая проверка начинается с пустого реестра: порядок проверок не должен
  // влиять на их исход.
  await db.provenance.deleteMany();
  await db.asset.deleteMany();
  await sandbox.put(MOSSY, PNG_1X1);
});

after(async () => {
  await db.$disconnect();
  await sandbox.dispose();
});

test('registered: первый импорт создаёт ассет с происхождением', async () => {
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'registered');
  assert.equal(outcome.asset.relativePath, MOSSY);
  assert.equal(outcome.asset.sha256, PNG_1X1_SHA256);
  assert.equal(outcome.asset.sizeBytes, PNG_1X1_BYTES);
  assert.equal(outcome.asset.type, 'image');
  assert.equal(outcome.asset.mimeType, 'image/png');
  assert.equal(await countAssets(db), 1);
});

test('provenance: импортированный ассет — import / unknown', async () => {
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.asset.provenance?.producedBy, 'import');
  assert.equal(outcome.asset.provenance?.reproducibility, 'unknown');

  // И то же самое после перечитывания из базы, а не только в возвращённом виде.
  const [stored] = await listAssets(db);
  assert.equal(stored?.provenance?.producedBy, 'import');
  assert.equal(stored?.provenance?.reproducibility, 'unknown');
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
  if (outcome.status === 'content-conflict') {
    assert.equal(outcome.asset.relativePath, MOSSY);
    assert.equal(outcome.requestedPath, copy);
  }
});

test('changed: тот же путь с другими байтами не затирает запись', async () => {
  const first = await importFile({ store, db }, MOSSY);

  // Файл перерендерили: путь прежний, содержимое другое.
  await sandbox.put(MOSSY, OTHER_PNG);

  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'content-changed');
  assert.equal(await countAssets(db), 1);
  if (outcome.status === 'content-changed') {
    assert.equal(outcome.asset.id, first.asset.id);
    assert.equal(outcome.asset.sha256, PNG_1X1_SHA256);
    assert.notEqual(outcome.currentSha256, PNG_1X1_SHA256);
  }
});

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
        producedBy: 'import',
        reproducibility: 'deterministic',
        note: null
      }),
    InvariantError
  );

  assert.equal(await countAssets(db), 0);
});

test('missing: отсутствующий файл не создаёт строку', async () => {
  await assert.rejects(() => importFile({ store, db }, 'characters/99/ref_front.png'));

  assert.equal(await countAssets(db), 0);
});
