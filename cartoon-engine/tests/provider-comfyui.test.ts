/**
 * Готовность провайдера ComfyUI.
 *
 * Сервер здесь не запускается ни разу: подставляется поддельный клиент.
 * Живой ComfyUI — отдельная история, и unit-проверки не должны от него
 * зависеть, иначе они перестанут проходить ровно тогда, когда нужнее всего.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ComfyClient } from '../packages/providers/comfyui/src/client';
import {
  ComfyUiImageEditProvider,
  WORKFLOW_NODES
} from '../packages/providers/comfyui/src/provider';
import { createSandbox, type Sandbox } from './fixtures';

/** Минимальный граф с теми же узлами, что и настоящий. */
const GRAPH = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'x.safetensors' } },
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'lightning.safetensors' } },
  '5': { class_type: 'CLIPLoader', inputs: {} },
  '6': { class_type: 'VAELoader', inputs: {} },
  '7': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
  '9': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { prompt: '' } },
  '12': { class_type: 'KSampler', inputs: { seed: 0, steps: 4 } },
  '14': { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } },
  '15': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'angles.safetensors' } }
};

const NODE_TYPES = new Set(Object.values(GRAPH).map((node) => node.class_type));

class FakeClient extends ComfyClient {
  constructor(
    private readonly behaviour: {
      stats?: () => Promise<unknown>;
      nodes?: () => Promise<Set<string>>;
    } = {}
  ) {
    super('http://127.0.0.1:8188');
  }

  override async systemStats(): Promise<never> {
    return (this.behaviour.stats
      ? this.behaviour.stats()
      : Promise.resolve({ system: { comfyui_version: '0.30.0' }, devices: [] })) as never;
  }

  override async knownNodeTypes(): Promise<Set<string>> {
    return this.behaviour.nodes ? this.behaviour.nodes() : NODE_TYPES;
  }
}

let sandbox: Sandbox;
let workflowPath: string;
let installRoot: string;

const MODELS = ['models/a.safetensors', 'models/b.safetensors'];

before(async () => {
  sandbox = await createSandbox();

  workflowPath = path.join(sandbox.root, 'workflow.json');
  await writeFile(workflowPath, JSON.stringify(GRAPH), 'utf8');

  installRoot = path.join(sandbox.root, 'comfy');
  for (const relative of MODELS) {
    await mkdir(path.dirname(path.join(installRoot, relative)), { recursive: true });
    await writeFile(path.join(installRoot, relative), 'weights');
  }
});

after(async () => {
  await sandbox.dispose();
});

function provider(overrides: Partial<ConstructorParameters<typeof ComfyUiImageEditProvider>[0]> = {}) {
  return new ComfyUiImageEditProvider({
    baseUrl: 'http://127.0.0.1:8188',
    workflowPath,
    installRoot,
    requiredModelFiles: MODELS,
    client: new FakeClient(),
    ...overrides
  });
}

test('configStatus: всё на месте — ready, и окружение снято', async () => {
  const status = await provider().configStatus();

  assert.equal(status.state, 'ready');
  assert.equal(status.detail, '');
  assert.ok(status.facts);
  assert.equal(status.facts?.['comfyuiVersion'], '0.30.0');
  // Веса описаны размером и временем — это их опознание без чтения 20 ГБ.
  assert.ok(status.facts?.['models']);
  assert.ok(status.facts?.['workflow']);
});

test('configStatus: нет адреса — missing-config', async () => {
  const status = await provider({ baseUrl: '' }).configStatus();
  assert.equal(status.state, 'missing-config');
});

test('configStatus: удалённый адрес отвергается', async () => {
  const status = await provider({ baseUrl: 'https://comfy.example.com' }).configStatus();

  assert.equal(status.state, 'missing-config');
  assert.match(status.detail, /не локальный/);
});

test('configStatus: сервер не отвечает — unavailable', async () => {
  const status = await provider({
    client: new FakeClient({ stats: () => Promise.reject(new Error('ECONNREFUSED')) })
  }).configStatus();

  assert.equal(status.state, 'unavailable');
  assert.match(status.detail, /ECONNREFUSED/);
});

test('configStatus: нет весов — model-missing', async () => {
  const status = await provider({
    requiredModelFiles: ['models/missing.safetensors']
  }).configStatus();

  assert.equal(status.state, 'model-missing');
  assert.match(status.detail, /missing\.safetensors/);
});

test('configStatus: нечитаемый workflow — workflow-invalid', async () => {
  const status = await provider({
    workflowPath: path.join(sandbox.root, 'nope.json')
  }).configStatus();

  assert.equal(status.state, 'workflow-invalid');
});

test('configStatus: сервер не знает узлов — workflow-invalid', async () => {
  const status = await provider({
    client: new FakeClient({ nodes: () => Promise.resolve(new Set(['UNETLoader'])) })
  }).configStatus();

  assert.equal(status.state, 'workflow-invalid');
  assert.match(status.detail, /не знает узлов/);
});

test('configStatus: в графе нет узла, который провайдер меняет — workflow-invalid', async () => {
  const broken = { ...GRAPH } as Record<string, unknown>;
  delete broken[WORKFLOW_NODES.loadImage];

  const brokenPath = path.join(sandbox.root, 'broken.json');
  await writeFile(brokenPath, JSON.stringify(broken), 'utf8');

  const status = await provider({ workflowPath: brokenPath }).configStatus();

  assert.equal(status.state, 'workflow-invalid');
  assert.match(status.detail, /нет узла 7/);
});

test('estimate: сети не касается и доллары считает нулём', () => {
  // Клиент, который взорвётся при любом обращении: если estimate полезет в
  // сеть, проверка это увидит.
  const exploding = new FakeClient({
    stats: () => Promise.reject(new Error('estimate не должен ходить в сеть')),
    nodes: () => Promise.reject(new Error('estimate не должен ходить в сеть'))
  });

  const estimate = provider({ client: exploding }).estimate({
    reference: { fileName: 'ref.png', bytes: Buffer.alloc(0) },
    prompt: 'p',
    seed: '1',
    modelKey: 'comfyui/qwen-image-edit-2509',
    parameters: { steps: 4 }
  });

  assert.equal(estimate.spend.usd, 0);
  assert.equal(estimate.spend.settled, true);
  // Ноль долларов — знание. Незнание записывалось бы как null.
  assert.notEqual(estimate.spend.usd, null);
  assert.equal(estimate.spend.credits, null);
  assert.ok(estimate.basis.length > 0);
});

test('client: локальность адреса проверяется до запроса', () => {
  assert.equal(ComfyClient.isLocal('http://127.0.0.1:8188'), true);
  assert.equal(ComfyClient.isLocal('http://localhost:8188'), true);
  assert.equal(ComfyClient.isLocal('https://api.example.com'), false);
  assert.equal(ComfyClient.isLocal('не адрес'), false);
});
