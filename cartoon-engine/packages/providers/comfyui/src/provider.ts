/**
 * Провайдер image-edit поверх локального ComfyUI.
 *
 * Жизненный цикл не спрятан: submit отдаёт дескриптор запуска, poll сообщает
 * состояние, fetch забирает результат. Спрятать его в один вызов означало бы
 * потерять дескриптор при падении процесса — а запуск на той стороне при этом
 * продолжится и займёт единственную в проекте видеокарту.
 *
 * Граф не выдумывается. Берётся файл workflow, найденный в установке ComfyUI, и
 * в нём подменяются только те поля, которые обязаны меняться от запуска к
 * запуску: имя входного файла, промпт, seed и параметры сэмплера.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  freeLocalSpend,
  ProviderResponseError,
  ProviderRunFailedError,
  type ConfigStatus,
  type Estimate,
  type ImageEditInput,
  type ImageEditOutput,
  type ImageEditProvider,
  type ProviderRun,
  type RunState
} from '@core/index';
import { ComfyClient, type ComfyImageRef } from './client';

/**
 * Узлы графа, которые провайдер имеет право менять.
 *
 * Идентификаторы взяты из фактического файла `04_multiview_qwen.json`, а не
 * придуманы. Если файл заменят и идентификаторы разъедутся, проверка готовности
 * это увидит и скажет workflow-invalid — молча подставить значение не в тот
 * узел нельзя.
 */
export const WORKFLOW_NODES = {
  loadImage: '7',
  positivePrompt: '9',
  sampler: '12',
  saveImage: '14',
  unet: '1',
  angleLora: '15',
  lightningLora: '2'
} as const;

export type ComfyUiProviderOptions = {
  baseUrl: string;
  /** Абсолютный путь к API-workflow. */
  workflowPath: string;
  /** Корень установки ComfyUI — нужен, чтобы удостовериться в наличии весов. */
  installRoot: string;
  /** Файлы весов, без которых граф не запустится. Пути от installRoot. */
  requiredModelFiles: readonly string[];
  client?: ComfyClient;
};

type LoadedWorkflow = {
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  /** Отпечаток ШАБЛОНА: отвечает на вопрос «тот ли это граф». */
  templateHash: string;
  raw: string;
};

export class ComfyUiImageEditProvider implements ImageEditProvider {
  readonly id = 'comfyui';
  readonly capability = 'image-edit' as const;
  readonly runtime = 'local' as const;

  private readonly client: ComfyClient;
  private workflow: LoadedWorkflow | null = null;
  /** Результаты submit, чтобы fetch знал, что именно спрашивать. */
  private readonly submitted = new Map<string, { promptId: string; startedAt: number }>();
  private lastEnvFacts: Record<string, unknown> | null = null;

  constructor(private readonly options: ComfyUiProviderOptions) {
    this.client = options.client ?? new ComfyClient(options.baseUrl);
  }

  private async loadWorkflow(): Promise<LoadedWorkflow> {
    if (this.workflow) return this.workflow;

    const raw = await readFile(this.options.workflowPath, 'utf8');
    const graph = JSON.parse(raw) as LoadedWorkflow['graph'];

    this.workflow = {
      graph,
      raw,
      templateHash: createHash('sha256').update(raw, 'utf8').digest('hex')
    };
    return this.workflow;
  }

  /**
   * Готовность. Ни одного шага генерации.
   *
   * Порядок проверок — от дешёвого к дорогому и от общего к частному, чтобы
   * первое же несоответствие называлось своим именем: нелокальный адрес, потом
   * отсутствие файла графа, потом недоступный сервер, потом отсутствие весов,
   * потом несовпадение узлов.
   */
  async configStatus(): Promise<ConfigStatus> {
    if (!this.options.baseUrl) {
      return {
        state: 'missing-config',
        detail: 'COMFYUI_BASE_URL не задан.',
        facts: null
      };
    }
    if (!ComfyClient.isLocal(this.options.baseUrl)) {
      return {
        state: 'missing-config',
        detail:
          `Адрес ${this.options.baseUrl} не локальный. Этот провайдер работает ` +
          'только с ComfyUI на этой машине: удалённый адрес означал бы внешний ' +
          'сервис, а он в задаче запрещён.',
        facts: null
      };
    }

    let workflow: LoadedWorkflow;
    try {
      workflow = await this.loadWorkflow();
    } catch (error) {
      return {
        state: 'workflow-invalid',
        detail: `Не читается ${this.options.workflowPath}: ${(error as Error).message}`,
        facts: null
      };
    }

    // Веса — на диске, а не в ответе сервера: сервер может быть жив, а модель
    // подменена или недокачана.
    const models: Record<string, { sizeBytes: number; mtimeMs: number }> = {};
    for (const relative of this.options.requiredModelFiles) {
      const absolute = path.join(this.options.installRoot, relative);
      const stats = await stat(absolute).catch(() => null);
      if (!stats || !stats.isFile()) {
        return {
          state: 'model-missing',
          detail: `Нет файла весов: ${absolute}`,
          facts: null
        };
      }
      models[relative] = { sizeBytes: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
    }

    let stats;
    let nodes: Set<string>;
    try {
      stats = await this.client.systemStats();
      nodes = await this.client.knownNodeTypes();
    } catch (error) {
      return {
        state: 'unavailable',
        detail:
          `ComfyUI не отвечает на ${this.options.baseUrl}: ${(error as Error).message}. ` +
          'Запустите сервер и повторите.',
        facts: null
      };
    }

    const required = new Set(Object.values(workflow.graph).map((node) => node.class_type));
    const missing = [...required].filter((type) => !nodes.has(type));
    if (missing.length > 0) {
      return {
        state: 'workflow-invalid',
        detail: `Сервер не знает узлов: ${missing.join(', ')}`,
        facts: null
      };
    }

    for (const [key, nodeId] of Object.entries(WORKFLOW_NODES)) {
      if (!workflow.graph[nodeId]) {
        return {
          state: 'workflow-invalid',
          detail: `В графе нет узла ${nodeId}, который провайдер меняет как «${key}».`,
          facts: null
        };
      }
    }

    const facts: Record<string, unknown> = {
      comfyuiVersion: stats.system?.comfyui_version ?? null,
      pythonVersion: stats.system?.python_version ?? null,
      pytorchVersion: stats.system?.pytorch_version ?? null,
      os: stats.system?.os ?? null,
      devices: (stats.devices ?? []).map((device) => ({
        name: device.name ?? null,
        vramTotal: device.vram_total ?? null
      })),
      models,
      workflow: {
        path: path.basename(this.options.workflowPath),
        sha256: workflow.templateHash
      }
    };
    this.lastEnvFacts = facts;

    return { state: 'ready', detail: '', facts };
  }

  /**
   * Оценка. Сети не касается — только арифметика по известным параметрам.
   *
   * Долларов ноль, и это знание, а не незнание. Время GPU — оценка по числу
   * шагов; она заведомо груба, и это сказано в basis, а не спрятано.
   */
  estimate(input: ImageEditInput): Estimate {
    const steps = typeof input.parameters['steps'] === 'number' ? input.parameters['steps'] : 4;

    return {
      spend: freeLocalSpend(),
      load: {
        // Ориентир для 20-гигабайтной модели на 16 ГБ VRAM: первая загрузка
        // весов занимает минуты, дальше считают только шаги. Число служит для
        // планирования очереди, а не для обещаний.
        gpuSeconds: null,
        wallClockMs: steps * 15_000,
        queueDepth: null
      },
      basis:
        `локальный ComfyUI, долларов не тратит; грубая прикидка ${steps} шагов ` +
        'по 15 с, без учёта первой загрузки весов'
    };
  }

  /** Собрать граф под конкретный запуск. Меняются только переменные поля. */
  private buildGraph(
    template: LoadedWorkflow,
    uploadedName: string,
    input: ImageEditInput
  ): Record<string, unknown> {
    const graph = JSON.parse(template.raw) as LoadedWorkflow['graph'];

    const loadImage = graph[WORKFLOW_NODES.loadImage];
    const positive = graph[WORKFLOW_NODES.positivePrompt];
    const sampler = graph[WORKFLOW_NODES.sampler];
    const save = graph[WORKFLOW_NODES.saveImage];

    if (!loadImage || !positive || !sampler || !save) {
      throw new ProviderResponseError('Граф потерял узлы между проверкой и запуском.');
    }

    loadImage.inputs['image'] = uploadedName;
    positive.inputs['prompt'] = input.prompt;

    sampler.inputs['seed'] = Number(input.seed);
    for (const key of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
      if (key in input.parameters) sampler.inputs[key] = input.parameters[key];
    }

    const prefix = input.parameters['filename_prefix'];
    if (typeof prefix === 'string') save.inputs['filename_prefix'] = prefix;

    return graph;
  }

  async submit(input: ImageEditInput): Promise<ProviderRun> {
    const template = await this.loadWorkflow();
    const uploaded = await this.client.uploadImage(
      input.reference.fileName,
      input.reference.bytes
    );

    const graph = this.buildGraph(template, uploaded.name, input);
    const clientId = `cartoon-engine-${input.seed}`;
    const promptId = await this.client.queuePrompt(graph, clientId);

    this.submitted.set(promptId, { promptId, startedAt: Date.now() });

    return { ref: promptId, submittedAt: new Date().toISOString() };
  }

  async poll(run: ProviderRun): Promise<RunState> {
    const entry = await this.client.history(run.ref);

    if (!entry) {
      const depth = await this.client.queueDepth();
      return depth !== null && depth > 0
        ? { state: 'pending', queuePosition: depth }
        : { state: 'running' };
    }

    const status = entry.status?.status_str;
    if (status === 'error') {
      return {
        state: 'failed',
        detail: JSON.stringify(entry.status?.messages ?? []).slice(0, 800)
      };
    }
    if (entry.status?.completed === true || status === 'success') {
      return { state: 'succeeded' };
    }

    return { state: 'running' };
  }

  async fetch(run: ProviderRun): Promise<ImageEditOutput> {
    const template = await this.loadWorkflow();
    const entry = await this.client.history(run.ref);

    if (!entry) {
      throw new ProviderRunFailedError(
        `Запуск ${run.ref} исчез из истории ComfyUI, результата нет.`,
        run.ref,
        false
      );
    }

    const images = Object.values(entry.outputs ?? {}).flatMap(
      (output) => output.images ?? []
    );
    const image: ComfyImageRef | undefined = images[0];

    if (!image) {
      throw new ProviderRunFailedError(
        `Запуск ${run.ref} завершился, но ни одного изображения не вернул.`,
        run.ref,
        false
      );
    }
    if (images.length > 1) {
      throw new ProviderResponseError(
        `Запуск ${run.ref} вернул ${images.length} изображений. Ожидалось одно: ` +
          'ассет должен соответствовать ровно одному файлу.'
      );
    }

    const bytes = await this.client.view(image);
    const startedAt = this.submitted.get(run.ref)?.startedAt ?? null;

    return {
      bytes,
      providerFileName: image.filename,
      workflowHash: template.templateHash,
      envFingerprint: this.lastEnvFacts ?? {},
      spend: freeLocalSpend(run.ref),
      load: {
        gpuSeconds: null,
        wallClockMs: startedAt === null ? null : Date.now() - startedAt,
        queueDepth: await this.client.queueDepth()
      }
    };
  }
}
