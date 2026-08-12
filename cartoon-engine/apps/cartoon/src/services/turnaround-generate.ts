/**
 * Генерация ракурса персонажа.
 *
 * Здесь сходятся все правила: провайдер только производит байты, а решение о
 * том, чем они являются и можно ли их повторить, принимает система.
 *
 * Провайдер НЕ назначает происхождение. `producedBy` и `reproducibility`
 * вычисляются в этом модуле из фактов — какой провайдер, локальный ли он,
 * проверена ли устойчивость seed, записаны ли отпечатки. Самоаттестация
 * провайдера ничего не стоит и в базу не попадает.
 */
import { createHash } from 'node:crypto';
import {
  computeReproducibility,
  createAssetWithProvenance,
  explainReproducibility,
  findCurrentAssetByCharacterAndRole,
  InvariantError,
  isReady,
  ProviderNotReadyError,
  ProviderRunFailedError,
  requireModel,
  type AssetView,
  type EngineDb,
  type ImageEditProvider,
  type MediaStore,
  type ProviderRun,
  type Spend
} from '@core/index';
import { findCharacterBySlug } from '../repositories/characters';
import { assertAssetRole } from '../domain/roles';
import {
  buildTurnaroundPrompt,
  requireAngle,
  turnaroundPath,
  type TurnaroundAngle
} from '../domain/turnaround';

export const TURNAROUND_ROLE = 'turnaround';
export const REFERENCE_ROLE = 'ref-front';
export const REFERENCE_INPUT_ROLE = 'reference';

/** Базовая модель, от которой считается происхождение ракурса. */
export const TURNAROUND_MODEL_KEY = 'comfyui/qwen-image-edit-2509';

/** Сопутствующие модели: их версии тоже уезжают в параметры запуска. */
export const TURNAROUND_LORA_KEYS = [
  'comfyui/qwen-edit-2509-multiple-angles',
  'comfyui/qwen-image-edit-2509-lightning-4steps'
] as const;

export type GenerateOptions = {
  slug: string;
  angle: TurnaroundAngle;
  /** Фиксируется вызывающим: случайный seed сделал бы запуск неповторимым. */
  seed: string;
  steps: number;
  cfg: number;
  /** Как часто спрашивать провайдера о состоянии. */
  pollIntervalMs?: number;
  /** Сколько всего ждать. Локальная модель на 20 ГБ грузится минутами. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
};

export type GenerateResult = {
  asset: AssetView;
  reference: AssetView;
  run: ProviderRun;
  prompt: string;
  wallClockMs: number;
};

function canonicalJson(value: unknown): string {
  // Ключи по алфавиту: отпечаток окружения должен зависеть от содержимого, а
  // не от порядка, в котором его собрали.
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        )
      );
    }
    return item;
  });
}

export function fingerprintHash(fingerprint: unknown): string {
  return createHash('sha256').update(canonicalJson(fingerprint), 'utf8').digest('hex');
}

export async function generateTurnaround(
  deps: { store: MediaStore; db: EngineDb; provider: ImageEditProvider },
  options: GenerateOptions
): Promise<GenerateResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const report = options.onProgress ?? (() => {});

  assertAssetRole(TURNAROUND_ROLE);
  const angle = requireAngle(options.angle);
  const model = requireModel(TURNAROUND_MODEL_KEY);
  const loras = TURNAROUND_LORA_KEYS.map(requireModel);

  // --- 1. персонаж и его эталон --------------------------------------------
  const character = await findCharacterBySlug(deps.db, options.slug);
  if (!character) {
    throw new InvariantError(`Персонажа ${options.slug} в базе нет.`);
  }

  const reference = await findCurrentAssetByCharacterAndRole(
    deps.db,
    character.id,
    REFERENCE_ROLE
  );
  if (!reference) {
    throw new InvariantError(
      `У персонажа ${options.slug} нет эталона с ролью ${REFERENCE_ROLE}.`
    );
  }

  // --- 2. готовность провайдера — до любой работы --------------------------
  const status = await deps.provider.configStatus();
  if (!isReady(status)) {
    throw new ProviderNotReadyError(
      `Провайдер ${deps.provider.id} не готов (${status.state}): ${status.detail}`,
      status
    );
  }

  // --- 3. путь результата: новый, никогда не поверх существующего ----------
  const outputPath = turnaroundPath(character.slug, angle.angle, options.seed);
  if (await deps.store.exists(outputPath)) {
    throw new InvariantError(
      `${outputPath} уже существует. Тот же ракурс с тем же seed уже сделан — ` +
        'перезаписывать его нельзя. Возьмите другой seed.'
    );
  }

  // --- 4. запуск ------------------------------------------------------------
  const prompt = buildTurnaroundPrompt(character.promptLine, angle);
  const parameters: Record<string, unknown> = {
    steps: options.steps,
    cfg: options.cfg,
    sampler_name: 'euler',
    scheduler: 'simple',
    denoise: 1.0,
    filename_prefix: `turnaround_${character.slug}_${angle.angle}`,
    loras: loras.map((lora) => ({ key: lora.key, target: lora.target, version: lora.version })),
    cameraPhrase: angle.cameraPhrase
  };

  const referenceBytes = await deps.store.readBytes(reference.relativePath);
  const input = {
    reference: { fileName: 'ref_front.png', bytes: referenceBytes },
    prompt,
    seed: options.seed,
    modelKey: model.key,
    parameters
  };

  const estimate = deps.provider.estimate(input);
  report(`оценка: ${estimate.basis}`);

  const startedAt = Date.now();
  const run = await deps.provider.submit(input);
  report(`запуск отправлен, providerRunRef = ${run.ref}`);

  // Опрос состояния. Дескриптор уже получен, поэтому даже падение здесь не
  // теряет запуск: по ref его можно найти в истории провайдера.
  let lastState = '';
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new ProviderRunFailedError(
        `Запуск ${run.ref} не завершился за ${Math.round(timeoutMs / 1000)} с. ` +
          'Он мог остаться в очереди ComfyUI — проверьте по этому идентификатору.',
        run.ref,
        false
      );
    }

    const state = await deps.provider.poll(run);
    if (state.state !== lastState) {
      report(`состояние: ${state.state}`);
      lastState = state.state;
    }

    if (state.state === 'succeeded') break;
    if (state.state === 'failed') {
      throw new ProviderRunFailedError(
        `Запуск ${run.ref} не удался: ${state.detail}`,
        run.ref,
        false
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const output = await deps.provider.fetch(run);
  const wallClockMs = Date.now() - startedAt;
  report(`результат получен за ${Math.round(wallClockMs / 1000)} с`);

  // --- 5. байты в реестр ----------------------------------------------------
  // receive не умеет перезаписывать: флаг 'wx' отказывает на уровне системного
  // вызова, так что существующий файл не пострадает даже при гонке.
  const facts = await deps.store.receive(outputPath, output.bytes);

  // --- 6. происхождение назначает система ----------------------------------
  const envFingerprint = {
    ...output.envFingerprint,
    capturedFor: run.ref
  };
  const envHash = fingerprintHash(envFingerprint);

  const spend: Spend = output.spend;

  const reproducibilityFacts = {
    producedBy: 'provider' as const,
    runtime: deps.provider.runtime,
    seedStable: model.determinism.seedStable,
    seedRecorded: options.seed.length > 0,
    envFingerprintRecorded: envHash.length > 0,
    workflowRecorded: output.workflowHash.length > 0,
    // Эталон импортирован, а не сделан руками: ручных шагов в цепочке нет.
    hasHumanAncestor: reference.provenance?.producedBy === 'human'
  };

  const reproducibility = computeReproducibility(reproducibilityFacts);

  const asset = await createAssetWithProvenance(deps.db, {
    relativePath: facts.relativePath,
    type: facts.type,
    mimeType: facts.mimeType,
    sizeBytes: facts.sizeBytes,
    sha256: facts.sha256,
    width: facts.width,
    height: facts.height,
    role: TURNAROUND_ROLE,
    characterId: character.id,
    version: 1,
    supersedesId: null,
    provenance: {
      producedBy: 'provider',
      reproducibility,
      note: explainReproducibility(reproducibilityFacts),
      providerId: deps.provider.id,
      modelKey: model.key,
      modelVersion: model.version,
      prompt,
      seed: options.seed,
      parameters: JSON.stringify(parameters),
      workflowHash: output.workflowHash,
      providerRunRef: run.ref,
      envFingerprint: JSON.stringify(envFingerprint),
      envFingerprintHash: envHash,
      spend: JSON.stringify({ ...spend, load: output.load })
    },
    inputs: [{ inputAssetId: reference.id, role: REFERENCE_INPUT_ROLE }]
  });

  return { asset, reference, run, prompt, wallClockMs };
}
