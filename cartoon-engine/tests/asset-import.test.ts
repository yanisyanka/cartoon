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
  countAssetAliases,
  countAssets,
  createAssetWithProvenance,
  findCurrentAssetByCharacterAndRole,
  listAssetAliases,
  listAssets,
  listCurrentAssets,
  listVersionsByPath,
  recordAssetAlias
} from '../packages/core/src/repositories/assets';
import { InvariantError } from '../packages/core/src/errors';
import { isAssetRole } from '../apps/cartoon/src/domain/roles';
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

test('cameraAngle: эталон живёт без ракурса, и это не пробел', async () => {
  // Применимость ракурса выводится из роли: у эталона, карточки и клипа его нет
  // не потому, что забыли проставить, а потому, что понятие к ним не относится.
  const outcome = await importFile({ store, db }, MOSSY, {
    classification: { role: 'ref-front' }
  });

  assert.equal(outcome.asset.cameraAngle, null);
});

test('cameraAngle: наследуется новой версией так же, как роль', async () => {
  await importFile({ store, db }, MOSSY, {
    classification: { role: 'turnaround', cameraAngle: 'three-quarter-left' }
  });

  await sandbox.put(MOSSY, OTHER_PNG);
  const outcome = await importFile({ store, db }, MOSSY);

  assert.equal(outcome.status, 'new-version');
  assert.equal(outcome.asset.role, 'turnaround');
  assert.equal(outcome.asset.cameraAngle, 'three-quarter-left');
});

test('cameraAngle: проставленный ракурс импортом не переписывается', async () => {
  await importFile({ store, db }, MOSSY, {
    classification: { role: 'turnaround', cameraAngle: 'three-quarter-left' }
  });

  await assert.rejects(
    importFile({ store, db }, MOSSY, {
      classification: { cameraAngle: 'back' }
    }),
    InvariantError
  );

  const [asset] = await listAssets(db);
  assert.equal(asset?.cameraAngle, 'three-quarter-left');
});

// --- задний эталон -------------------------------------------------------------

test('ref-back: роль есть в словаре и отличима от turnaround', () => {
  assert.equal(isAssetRole('ref-back'), true);
  assert.notEqual('ref-back', 'turnaround');
  // Эталон и продукция — разные категории, и словарь обязан их различать:
  // на эталон ссылаются как на источник, продукцию переделывают.
  assert.equal(isAssetRole('ref-front'), true);
});

test('ref-back: эталон несёт ракурс back и не является версией ракурса', async () => {
  await sandbox.put(MOSSY, PNG_1X1);
  const outcome = await importFile({ store, db }, MOSSY, {
    classification: { role: 'ref-back', cameraAngle: 'back' }
  });

  assert.equal(outcome.asset.role, 'ref-back');
  assert.equal(outcome.asset.cameraAngle, 'back');
  assert.equal(outcome.asset.version, 1);
  assert.equal(outcome.asset.supersedesId, null);
});

test('ref-back: вход с ролью source отличается от reference', async () => {
  // Кадр вырезан из клипа, а не порождён из него генерацией. Роль входа
  // называет именно это, и по ней две цепочки не спутать.
  await sandbox.put(MOSSY, PNG_1X1);
  const clip = await importFile({ store, db }, MOSSY, {
    classification: { role: 'clip' }
  });

  const frame = await createAssetWithProvenance(db, {
    relativePath: 'characters/01-mossy/ref_back.png',
    type: 'image',
    mimeType: 'image/png',
    sizeBytes: 10,
    sha256: 'b'.repeat(64),
    width: 828,
    height: 1108,
    role: 'ref-back',
    cameraAngle: 'back',
    characterId: null,
    version: 1,
    supersedesId: null,
    provenance: {
      producedBy: 'provider',
      reproducibility: 'stochastic',
      note: 'вырезан из клипа',
      modelKey: 'ffmpeg/cli'
    },
    inputs: [{ inputAssetId: clip.asset.id, role: 'source' }]
  });

  assert.equal(frame.inputs.length, 1);
  assert.equal(frame.inputs[0]?.role, 'source');
  assert.notEqual(frame.inputs[0]?.role, 'reference');
  assert.equal(frame.inputs[0]?.inputRelativePath, MOSSY);

  // Убираем за собой связь: на inputAssetId стоит onDelete: Restrict, и общая
  // очистка перед следующим тестом не смогла бы удалить клип, пока на него
  // ссылаются. Это не обход защиты, а её признание.
  await db.assetInput.deleteMany({ where: { assetId: frame.id } });
  await db.asset.delete({ where: { id: frame.id } });
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

test('hash: отпечаток совпадает с независимым расчётом по сырым байтам', async () => {
  // Считается мимо MediaStore: обычным чтением файла целиком. Совпадение
  // означает, что потоковый однопроходный расчёт не расходится с прямым.
  const outcome = await importFile({ store, db }, MOSSY);
  const raw = await readFile(path.join(sandbox.root, MOSSY));
  const independent = createHash('sha256').update(raw).digest('hex');

  assert.equal(outcome.asset.sha256, independent);
  assert.equal(outcome.asset.sizeBytes, raw.length);
});

test('dimensions: размеры кадра читаются из PNG', async () => {
  const outcome = await importFile({ store, db }, MOSSY);

  // PNG_1X1 — настоящий PNG размером 1×1.
  assert.equal(outcome.asset.width, 1);
  assert.equal(outcome.asset.height, 1);
});

// --- псевдонимы --------------------------------------------------------------

test('alias: без флага копия остаётся конфликтом, а не записывается молча', async () => {
  const copy = 'archive/Москин.png';
  await sandbox.put(copy, PNG_1X1);

  await importFile({ store, db }, MOSSY);
  const outcome = await importFile({ store, db }, copy);

  assert.equal(outcome.status, 'content-conflict');
  assert.equal(await countAssetAliases(db), 0);
  assert.equal(await countAssets(db), 1);
});

test('alias: с флагом копия записывается вторым местом того же ассета', async () => {
  const copy = 'archive/Москин.png';
  await sandbox.put(copy, PNG_1X1);

  const first = await importFile({ store, db }, MOSSY);
  const outcome = await importFile({ store, db }, copy, { aliasNote: 'оригинал' });

  assert.equal(outcome.status, 'alias-recorded');
  if (outcome.status === 'alias-recorded') {
    assert.equal(outcome.asset.id, first.asset.id);
    assert.equal(outcome.aliasPath, copy);
    assert.equal(outcome.alreadyKnown, false);
  }

  // Ассет по-прежнему один: те же байты — один ассет, где бы они ни лежали.
  assert.equal(await countAssets(db), 1);
  assert.equal(await countAssetAliases(db), 1);

  const [alias] = await listAssetAliases(db);
  assert.equal(alias?.relativePath, copy);
  assert.equal(alias?.note, 'оригинал');
});

test('alias: повторная запись псевдонима не создаёт дубликата', async () => {
  const copy = 'archive/Москин.png';
  await sandbox.put(copy, PNG_1X1);

  await importFile({ store, db }, MOSSY);
  await importFile({ store, db }, copy, { aliasNote: 'оригинал' });
  const second = await importFile({ store, db }, copy, { aliasNote: 'оригинал' });

  assert.equal(second.status, 'alias-recorded');
  if (second.status === 'alias-recorded') assert.equal(second.alreadyKnown, true);
  assert.equal(await countAssetAliases(db), 1);
});

test('alias: путь настоящего ассета псевдонимом стать не может', async () => {
  const other = 'archive/other.png';
  await sandbox.put(other, OTHER_PNG);

  const mossy = await importFile({ store, db }, MOSSY);
  await importFile({ store, db }, other);

  // Оба пути заняты самостоятельными ассетами; объявить один копией другого —
  // значит описать одно место дважды и по-разному.
  await assert.rejects(
    () => recordAssetAlias(db, mossy.asset.id, other, null),
    InvariantError
  );

  assert.equal(await countAssetAliases(db), 0);
});

/**
 * Версия заднего эталона, порождённая движком.
 *
 * До CE-TASK-005A версии появлялись только от руки: человек подменял файл, а
 * импорт описывал то, что уже лежало. Кадр, выбранный человеком, при этом мог
 * оказаться неверным — у Твиглета выбранный кадр отстоял от затылка на 18°, — и
 * заменить эталон было нечем. Здесь проверяется, что замена делается движком и
 * при этом не ломает ни модель версий, ни происхождение.
 */
test('версия ref-back: замена байтов по пути даёт v2, а v1 остаётся историей', async () => {
  const BACK = 'characters/09-audit/ref_back.png';

  const character = await db.character.create({
    data: {
      slug: '09-audit',
      number: 99,
      name: 'Audit',
      nameRu: 'Аудит',
      title: 'Проверка версий',
      promptLine: 'test spirit',
      colorAnchors: '["#000000"]',
      heightRatio: 1,
      frequency: 'постоянный',
      sourcePath: 'characters/09-audit/character.md',
      sourceSha256: 'c'.repeat(64)
    }
  });

  // Клип как источник. Роль важна, содержимое — нет: проверяется связь.
  const clip = await importFile({ store, db }, MOSSY, {
    classification: { role: 'clip', characterId: character.id }
  });

  // Посторонний ассет, которого происходящее не должно касаться.
  await sandbox.put('characters/09-audit/card.jpg', JPEG_MINIMAL);
  const bystander = await importFile({ store, db }, 'characters/09-audit/card.jpg', {
    classification: { role: 'card', characterId: character.id }
  });

  const ffmpegProvenance = (frameIndex: number, sourceSha256: string) => ({
    producedBy: 'provider' as const,
    reproducibility: 'stochastic' as const,
    note: 'вырезан из клипа',
    providerId: 'ffmpeg',
    modelKey: 'ffmpeg/cli',
    modelVersion: '8.1.2',
    parameters: JSON.stringify({
      frameIndex,
      filter: `select=eq(n,${frameIndex})`,
      sourceRelativePath: MOSSY,
      sourceSha256
    })
  });

  // --- версия 1 ---------------------------------------------------------------
  await sandbox.put(BACK, OTHER_PNG);
  const firstFacts = await store.describe(BACK);
  const v1 = await createAssetWithProvenance(db, {
    relativePath: firstFacts.relativePath,
    type: firstFacts.type,
    mimeType: firstFacts.mimeType,
    sizeBytes: firstFacts.sizeBytes,
    sha256: firstFacts.sha256,
    width: firstFacts.width,
    height: firstFacts.height,
    role: 'ref-back',
    cameraAngle: 'back',
    characterId: character.id,
    version: 1,
    supersedesId: null,
    provenance: ffmpegProvenance(50, clip.asset.sha256),
    inputs: [{ inputAssetId: clip.asset.id, role: 'source' }]
  });

  const before = await listAssets(db);

  // --- версия 2: ровно то, что делает скрипт ----------------------------------
  const current = await findCurrentAssetByCharacterAndRole(db, character.id, 'ref-back');
  assert.ok(current);
  assert.equal(current.id, v1.id);

  const secondFacts = await store.replaceExisting(BACK, THIRD_PNG);
  const v2 = await createAssetWithProvenance(db, {
    relativePath: secondFacts.relativePath,
    type: secondFacts.type,
    mimeType: secondFacts.mimeType,
    sizeBytes: secondFacts.sizeBytes,
    sha256: secondFacts.sha256,
    width: secondFacts.width,
    height: secondFacts.height,
    role: 'ref-back',
    cameraAngle: 'back',
    characterId: character.id,
    version: current.version + 1,
    supersedesId: current.id,
    provenance: ffmpegProvenance(63, clip.asset.sha256),
    inputs: [{ inputAssetId: clip.asset.id, role: 'source' }]
  });

  // --- C. связь версий --------------------------------------------------------
  const versions = await listVersionsByPath(db, BACK);
  assert.deepEqual(
    versions.map((v) => v.version),
    [1, 2]
  );
  assert.equal(v2.version, v1.version + 1);
  assert.equal(v2.supersedesId, v1.id);
  assert.equal(v2.role, 'ref-back');
  assert.equal(v2.cameraAngle, 'back');
  assert.notEqual(v2.sha256, v1.sha256);

  // текущим считается вторая, а не та, чей путь меньше по алфавиту
  const now = await findCurrentAssetByCharacterAndRole(db, character.id, 'ref-back');
  assert.equal(now?.id, v2.id);
  assert.equal(now?.version, 2);

  // и текущих задних эталонов ровно один, а не два
  const currentAssets = await listCurrentAssets(db);
  const backs = currentAssets.filter((a) => a.role === 'ref-back');
  assert.equal(backs.length, 1);
  assert.equal(backs[0]?.id, v2.id);

  // Тот же инвариант в той форме, в какой его проверяет check:provider —
  // «у персонажа не больше одного ТЕКУЩЕГО заднего эталона». Перекрытая версия
  // отличается тем, что на неё кто-то ссылается через supersedesId; считать
  // сырые строки значило бы объявлять нарушением саму историю версий.
  const everything = await listAssets(db);
  const superseded = new Set(
    everything.map((a) => a.supersedesId).filter((id): id is string => id !== null)
  );
  const currentBacks = everything.filter((a) => a.role === 'ref-back' && !superseded.has(a.id));
  assert.deepEqual(currentBacks.map((a) => a.id), [v2.id]);
  assert.equal(superseded.has(v1.id), true, 'v1 обязана числиться перекрытой');

  // --- D. происхождение второй версии не беднее первой ------------------------
  assert.equal(v2.provenance?.producedBy, 'provider');
  assert.equal(v2.provenance?.modelKey, 'ffmpeg/cli');
  assert.equal(v2.provenance?.providerId, 'ffmpeg');
  const parameters = JSON.parse(v2.provenance?.parameters ?? '{}');
  assert.equal(parameters.frameIndex, 63);
  assert.equal(parameters.filter, 'select=eq(n,63)');
  assert.equal(parameters.sourceSha256, clip.asset.sha256);
  assert.equal(v2.inputs.length, 1);
  assert.equal(v2.inputs[0]?.role, 'source');
  assert.equal(v2.inputs[0]?.inputAssetId, clip.asset.id);

  // --- E. строка v1 не изменилась ни в одном поле -----------------------------
  const v1After = versions[0];
  assert.equal(v1After?.id, v1.id);
  assert.equal(v1After?.version, 1);
  assert.equal(v1After?.supersedesId, null);
  assert.equal(v1After?.sha256, v1.sha256);
  assert.equal(v1After?.role, 'ref-back');
  assert.equal(v1After?.createdAt, v1.createdAt);

  // Её отпечаток намеренно РАСХОДИТСЯ с диском: по пути теперь лежат байты v2.
  // Это и есть состояние перекрытой версии, а не порча реестра.
  assert.notEqual(v1After?.sha256, (await store.describe(BACK)).sha256);
  assert.equal((await store.describe(BACK)).sha256, v2.sha256);

  // Байты v1 восстановимы: их отпечаток известен и записан.
  assert.equal(createHash('sha256').update(OTHER_PNG).digest('hex'), v1.sha256);

  // --- F. остальные ассеты не тронуты -----------------------------------------
  const after = await listAssets(db);
  assert.equal(after.length, before.length + 1);
  for (const old of before) {
    const now2 = after.find((a) => a.id === old.id);
    assert.ok(now2, `ассет ${old.relativePath} исчез`);
    assert.equal(now2.sha256, old.sha256);
    assert.equal(now2.version, old.version);
    assert.equal(now2.supersedesId, old.supersedesId);
    assert.equal(now2.role, old.role);
  }
  assert.equal(
    (await store.describe('characters/09-audit/card.jpg')).sha256,
    bystander.asset.sha256
  );

  // Прибираем: на inputAssetId стоит onDelete: Restrict, общая очистка перед
  // следующим тестом не снесла бы клип, пока на него ссылаются.
  await db.assetInput.deleteMany({ where: { assetId: { in: [v1.id, v2.id] } } });
  await db.asset.delete({ where: { id: v2.id } });
  await db.asset.delete({ where: { id: v1.id } });
  await db.character.delete({ where: { id: character.id } });
});

test('версия ref-back: замена не создаёт второго текущего эталона по новому пути', async () => {
  // Страховка от соблазна «положить рядом»: если новая версия ляжет на другой
  // путь, текущим станет тот, чей путь меньше по алфавиту, то есть устаревший.
  assert.ok(
    'characters/03-twiglet/ref_back.png' < 'characters/03-twiglet/ref_back.v2.png',
    'порядок путей изменился — проверка ниже потеряла смысл'
  );

  const character = await db.character.create({
    data: {
      slug: '08-paths',
      number: 98,
      name: 'Paths',
      nameRu: 'Пути',
      title: 'Проверка путей',
      promptLine: 'test spirit',
      colorAnchors: '["#000000"]',
      heightRatio: 1,
      frequency: 'постоянный',
      sourcePath: 'characters/08-paths/character.md',
      sourceSha256: 'd'.repeat(64)
    }
  });

  const base = 'characters/08-paths/ref_back.png';
  const beside = 'characters/08-paths/ref_back.v2.png';
  await sandbox.put(base, OTHER_PNG);
  await sandbox.put(beside, THIRD_PNG);

  const mk = async (relativePath: string, version: number, supersedesId: string | null) => {
    const facts = await store.describe(relativePath);
    return createAssetWithProvenance(db, {
      relativePath: facts.relativePath,
      type: facts.type,
      mimeType: facts.mimeType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      width: facts.width,
      height: facts.height,
      role: 'ref-back',
      cameraAngle: 'back',
      characterId: character.id,
      version,
      supersedesId,
      provenance: {
        producedBy: 'provider',
        reproducibility: 'stochastic',
        note: 'проверка путей',
        modelKey: 'ffmpeg/cli'
      },
      inputs: []
    });
  };

  const v1 = await mk(base, 1, null);
  const v2beside = await mk(beside, 2, v1.id);

  // Версия по СОСЕДНЕМУ пути формально верна, но реестр после неё врёт:
  const current = await findCurrentAssetByCharacterAndRole(db, character.id, 'ref-back');
  assert.equal(current?.id, v1.id, 'вернулась бы устаревшая версия — путь меньше по алфавиту');
  assert.equal(current?.version, 1);

  const backs = (await listCurrentAssets(db)).filter((a) => a.role === 'ref-back');
  assert.equal(backs.length, 2, 'у персонажа оказалось два текущих задних эталона');

  await db.asset.delete({ where: { id: v2beside.id } });
  await db.asset.delete({ where: { id: v1.id } });
  await db.character.delete({ where: { id: character.id } });
});
