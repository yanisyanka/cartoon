/**
 * Генерация ракурса: происхождение, входы, воспроизводимость.
 *
 * ComfyUI здесь не запускается. Провайдер подставляется заглушкой с тем же
 * интерфейсом — проверяется стыковка слоёв и то, что решения о происхождении
 * принимает система, а не провайдер.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { createEngineDb, type EngineDb } from '../packages/core/src/db';
import { MediaStore } from '../packages/core/src/media-store';
import { MediaWriteError, InvariantError } from '../packages/core/src/errors';
import { importFile } from '../packages/core/src/services/asset-import';
import {
  countAssets,
  listAssets
} from '../packages/core/src/repositories/assets';
import { ProviderNotReadyError, ProviderRunFailedError } from '../packages/core/src/provider';
import { computeReproducibility } from '../packages/core/src/provenance';
import { requireModel } from '../packages/core/src/model-registry';
import type {
  ConfigStatus,
  Estimate,
  ImageEditInput,
  ImageEditOutput,
  ImageEditProvider,
  ProviderRun,
  RunState
} from '../packages/core/src/provider';
import { upsertCharacter } from '../apps/cartoon/src/repositories/characters';
import { generateTurnaround } from '../apps/cartoon/src/services/turnaround-generate';
import { createSandbox, PNG_1X1, type Sandbox } from './fixtures';

const MIGRATIONS_DIR = path.resolve('prisma/migrations');
const REF = 'characters/01-mossy/ref_front.png';

/** Другой валидный PNG — «результат генерации». */
const GENERATED_PNG = Buffer.concat([PNG_1X1, Buffer.from([0x00, 0x42])]);

/** Граф, который «запускала» заглушка. Сохраняется целиком, не только хешем. */
const STUB_WORKFLOW_JSON = JSON.stringify({
  '7': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
  '12': { class_type: 'KSampler', inputs: { seed: 0, steps: 4 } }
});

const PASSPORT = {
  slug: '01-mossy',
  number: 1,
  name: 'Mossy',
  nameRu: 'Москин',
  title: 'Хранитель мха и тишины',
  promptLine: 'mossy forest spirit, three red fly-agaric mushrooms, **no mouth**',
  colorAnchors: ['#4A5D3A', '#C43B2E'],
  heightRatio: 1.0,
  frequency: 'постоянный' as const,
  sourcePath: 'characters/01-mossy/character.md',
  sourceSha256: 'a'.repeat(64)
};

type StubOptions = {
  status?: ConfigStatus;
  bytes?: Buffer;
  failOnPoll?: boolean;
  workflowHash?: string;
  envFingerprint?: Record<string, unknown>;
};

/** Заглушка провайдера: запоминает вход и отдаёт заданный результат. */
class StubProvider implements ImageEditProvider {
  readonly id = 'stub-comfyui';
  readonly capability = 'image-edit' as const;
  readonly runtime = 'local' as const;

  lastInput: ImageEditInput | null = null;
  estimateCalls = 0;

  constructor(private readonly options: StubOptions = {}) {}

  async configStatus(): Promise<ConfigStatus> {
    return this.options.status ?? { state: 'ready', detail: '', facts: { fake: true } };
  }

  estimate(): Estimate {
    this.estimateCalls += 1;
    return {
      spend: { usd: 0, credits: null, tokens: null, settled: true, sourceRef: null },
      load: { gpuSeconds: null, wallClockMs: 1, queueDepth: null },
      basis: 'stub'
    };
  }

  async submit(input: ImageEditInput): Promise<ProviderRun> {
    this.lastInput = input;
    return { ref: 'stub-run-1', submittedAt: new Date(0).toISOString() };
  }

  async poll(): Promise<RunState> {
    return this.options.failOnPoll
      ? { state: 'failed', detail: 'OOM на видеокарте' }
      : { state: 'succeeded' };
  }

  async fetch(): Promise<ImageEditOutput> {
    return {
      bytes: this.options.bytes ?? GENERATED_PNG,
      providerFileName: 'turnaround_00001_.png',
      workflowHash:
        this.options.workflowHash ??
        createHash('sha256').update(STUB_WORKFLOW_JSON, 'utf8').digest('hex'),
      workflowJson: STUB_WORKFLOW_JSON,
      envFingerprint: this.options.envFingerprint ?? { comfyuiVersion: '0.30.0' },
      spend: { usd: 0, credits: null, tokens: null, settled: true, sourceRef: 'stub-run-1' },
      load: { gpuSeconds: null, wallClockMs: 10, queueDepth: 0 }
    };
  }
}

let sandbox: Sandbox;
let store: MediaStore;
let db: EngineDb;
let characterId: string;
let referenceId: string;

async function migrationSql(): Promise<string> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const parts: string[] = [];
  for (const directory of directories) {
    parts.push(await readFile(path.join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8'));
  }
  return parts.join('\n');
}

before(async () => {
  sandbox = await createSandbox();
  store = new MediaStore(sandbox.root);

  const dbPath = path.join(sandbox.root, 'turnaround.db');
  const raw = new Database(dbPath);
  raw.exec(await migrationSql());
  raw.close();

  db = createEngineDb(`file:${dbPath}`);
});

beforeEach(async () => {
  const all = await db.asset.findMany({ orderBy: { version: 'desc' } });
  for (const asset of all) {
    await db.assetInput.deleteMany({ where: { assetId: asset.id } });
  }
  for (const asset of all) {
    await db.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
  await db.character.deleteMany();

  const { character } = await upsertCharacter(db, PASSPORT);
  characterId = character.id;

  await sandbox.put(REF, PNG_1X1);
  const imported = await importFile(
    { store, db },
    REF,
    { classification: { role: 'ref-front', characterId } }
  );
  referenceId = imported.asset.id;

  // Результат прошлого прогона убираем, чтобы путь был свободен.
  await sandbox.remove('characters/01-mossy/turnaround');
});

after(async () => {
  await db.$disconnect();
  await sandbox.dispose();
});

const RUN = {
  slug: '01-mossy',
  angle: 'three-quarter-left' as const,
  seed: '20260812',
  steps: 4,
  cfg: 1.0,
  pollIntervalMs: 1
};

test('generate: создаёт ассет с ролью turnaround и персонажем', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  assert.equal(result.asset.role, 'turnaround');
  assert.equal(result.asset.characterId, characterId);
  assert.equal(
    result.asset.relativePath,
    'characters/01-mossy/turnaround/three-quarter-left.s20260812.png'
  );
  assert.equal(result.asset.version, 1);
});

test('provenance: producedBy назначает система, а не провайдер', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  assert.equal(result.asset.provenance?.producedBy, 'provider');
  assert.equal(result.asset.provenance?.providerId, 'stub-comfyui');
});

test('provenance: seed, workflow и окружение записаны', async () => {
  const provider = new StubProvider({ workflowHash: 'a'.repeat(64) });
  const result = await generateTurnaround({ store, db, provider }, RUN);

  const p = result.asset.provenance;
  assert.equal(p?.seed, '20260812');
  assert.equal(p?.workflowHash, 'a'.repeat(64));
  assert.ok(p?.envFingerprint && p.envFingerprint.length > 0);
  assert.match(p?.envFingerprintHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(p?.providerRunRef, 'stub-run-1');
  assert.equal(p?.modelKey, 'comfyui/qwen-image-edit-2509');
  assert.ok(p?.prompt && p.prompt.length > 0);
});

test('workflow: сохранён целиком, и его текст соответствует записанному sha256', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  const p = result.asset.provenance;
  assert.ok(p?.workflowJson, 'текст графа должен быть сохранён, а не только хеш');

  // Главная проверка: по записи можно ВОССТАНОВИТЬ граф, и он тот самый.
  const recomputed = createHash('sha256')
    .update(p?.workflowJson ?? '', 'utf8')
    .digest('hex');
  assert.equal(recomputed, p?.workflowHash);

  // И восстановленный текст — валидный JSON с теми же узлами.
  const graph = JSON.parse(p?.workflowJson ?? '{}') as Record<string, unknown>;
  assert.ok(graph['7']);
  assert.ok(graph['12']);
});

test('workflow: подменённый текст перестаёт сходиться с отпечатком', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  const tampered = `${result.asset.provenance?.workflowJson ?? ''} `;
  const recomputed = createHash('sha256').update(tampered, 'utf8').digest('hex');

  assert.notEqual(recomputed, result.asset.provenance?.workflowHash);
});

test('provenance: отпечаток окружения устойчив к порядку ключей', async () => {
  const first = new StubProvider({ envFingerprint: { a: 1, b: 2 } });
  const firstResult = await generateTurnaround({ store, db, provider: first }, RUN);
  const firstHash = firstResult.asset.provenance?.envFingerprintHash;

  await sandbox.remove('characters/01-mossy/turnaround');
  const all = await db.asset.findMany({ where: { role: 'turnaround' } });
  for (const asset of all) {
    await db.assetInput.deleteMany({ where: { assetId: asset.id } });
    await db.asset.delete({ where: { id: asset.id } });
  }

  const second = new StubProvider({ envFingerprint: { b: 2, a: 1 } });
  const secondResult = await generateTurnaround({ store, db, provider: second }, RUN);

  assert.equal(secondResult.asset.provenance?.envFingerprintHash, firstHash);
});

test('inputs: эталон записан входом с ролью reference', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  assert.equal(result.asset.inputs.length, 1);
  assert.equal(result.asset.inputs[0]?.inputAssetId, referenceId);
  assert.equal(result.asset.inputs[0]?.role, 'reference');
  assert.equal(result.asset.inputs[0]?.inputRelativePath, REF);
});

test('reproducibility: при неустойчивом seed класс stochastic, а не deterministic', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  // В реестре у Qwen seedStable = false — измерено 12.08.2026: два запуска с
  // одинаковыми seed, референсом, графом, параметрами и окружением дали разные
  // файлы. Поэтому deterministic недостижим по факту, а не по осторожности.
  assert.equal(result.asset.provenance?.reproducibility, 'stochastic');
  assert.match(result.asset.provenance?.note ?? '', /seed не даёт повторяемого результата/);
  assert.notEqual(result.asset.provenance?.reproducibility, 'unknown');
});

test('reproducibility: seedStable=false закрывает путь к deterministic', () => {
  // Прямая проверка правила, без генерации: даже когда всё остальное на месте,
  // один неустойчивый seed опускает класс. Несимметричность здесь намеренная.
  const complete = {
    producedBy: 'provider' as const,
    runtime: 'local' as const,
    seedRecorded: true,
    envFingerprintRecorded: true,
    workflowRecorded: true,
    hasHumanAncestor: false
  };

  assert.equal(computeReproducibility({ ...complete, seedStable: false }), 'stochastic');
  assert.equal(computeReproducibility({ ...complete, seedStable: null }), 'stochastic');
  assert.equal(computeReproducibility({ ...complete, seedStable: true }), 'deterministic');
});

test('registry: у моделей Qwen устойчивость seed измерена и равна false', () => {
  for (const key of [
    'comfyui/qwen-image-edit-2509',
    'comfyui/qwen-edit-2509-multiple-angles',
    'comfyui/qwen-image-edit-2509-lightning-4steps'
  ]) {
    assert.equal(requireModel(key).determinism.seedStable, false, key);
  }
});

test('reproducibility: провайдер не может объявить себя воспроизводимым', async () => {
  // Заглушка возвращает в отпечатке ложь про воспроизводимость — система
  // обязана её проигнорировать, потому что считает класс сама.
  const provider = new StubProvider({
    envFingerprint: { reproducibility: 'deterministic', producedBy: 'human' }
  });
  const result = await generateTurnaround({ store, db, provider }, RUN);

  assert.equal(result.asset.provenance?.reproducibility, 'stochastic');
  assert.equal(result.asset.provenance?.producedBy, 'provider');
});

test('prompt: собран из строки персонажа и не содержит кириллицы', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  assert.ok(result.prompt.includes(PASSPORT.promptLine));
  assert.ok(result.prompt.includes('将镜头向左旋转45度'));
  assert.equal(/[а-яё]/i.test(result.prompt), false);
  assert.equal(result.prompt.includes('pure black eyes with no iris'), false);
});

test('safety: провайдер получает байты эталона, а сам файл не меняется', async () => {
  const absolute = path.join(sandbox.root, REF);
  const before = await readFile(absolute);

  const provider = new StubProvider();
  await generateTurnaround({ store, db, provider }, RUN);

  const after = await readFile(absolute);
  assert.deepEqual(after, before);
  assert.deepEqual(provider.lastInput?.reference.bytes, before);
});

test('safety: результат не может лечь поверх существующего файла', async () => {
  const output = 'characters/01-mossy/turnaround/three-quarter-left.s20260812.png';
  await sandbox.put(output, PNG_1X1);

  const provider = new StubProvider();
  await assert.rejects(
    () => generateTurnaround({ store, db, provider }, RUN),
    InvariantError
  );

  // Файл на месте и не тронут.
  assert.deepEqual(await readFile(path.join(sandbox.root, output)), PNG_1X1);
});

test('safety: MediaStore.receive физически не перезаписывает', async () => {
  await sandbox.put('probe.png', PNG_1X1);
  await assert.rejects(
    () => store.receive('probe.png', GENERATED_PNG),
    MediaWriteError
  );
  assert.deepEqual(await readFile(path.join(sandbox.root, 'probe.png')), PNG_1X1);
});

test('failure: неготовый провайдер до работы не допускается', async () => {
  const provider = new StubProvider({
    status: { state: 'model-missing', detail: 'нет весов', facts: null }
  });

  await assert.rejects(
    () => generateTurnaround({ store, db, provider }, RUN),
    (error: unknown) => {
      assert.ok(error instanceof ProviderNotReadyError);
      assert.equal(error.status.state, 'model-missing');
      return true;
    }
  );

  // Ни строки, ни файла.
  assert.equal(await countAssets(db), 1);
  assert.equal(await store.exists('characters/01-mossy/turnaround'), false);
});

test('failure: провал запуска сохраняет providerRunRef', async () => {
  const provider = new StubProvider({ failOnPoll: true });

  await assert.rejects(
    () => generateTurnaround({ store, db, provider }, RUN),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRunFailedError);
      assert.equal(error.runRef, 'stub-run-1');
      assert.match(error.message, /OOM/);
      return true;
    }
  );

  assert.equal(await countAssets(db), 1);
});

test('idempotency: повторный импорт результата не создаёт дубликата', async () => {
  const provider = new StubProvider();
  const result = await generateTurnaround({ store, db, provider }, RUN);

  const before = await countAssets(db);
  const again = await importFile({ store, db }, result.asset.relativePath);

  assert.equal(again.status, 'already-registered');
  assert.equal(again.asset.id, result.asset.id);
  assert.equal(await countAssets(db), before);
});

test('estimate: вызывается до запуска ровно один раз', async () => {
  const provider = new StubProvider();
  await generateTurnaround({ store, db, provider }, RUN);

  assert.equal(provider.estimateCalls, 1);
});

test('generate: неизвестный персонаж — отказ до обращения к провайдеру', async () => {
  const provider = new StubProvider();

  await assert.rejects(
    () => generateTurnaround({ store, db, provider }, { ...RUN, slug: '99-nobody' }),
    InvariantError
  );

  assert.equal(provider.lastInput, null);
  assert.equal((await listAssets(db)).length, 1);
});
