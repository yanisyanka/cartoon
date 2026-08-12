/**
 * Реестр моделей.
 *
 * Таблица в коде, а не в базе. Цена и поведение модели — факты о мире; они
 * должны меняться через diff и ревью, а не тихой записью в строку. Ровно так же
 * в соседнем проекте живёт тариф Apify: константой, с комментарием о том, каким
 * запуском он подтверждён.
 *
 * Записей ровно столько, сколько используется сегодня. Полный реестр со всеми
 * провайдерами появится, когда появятся сами провайдеры.
 */
import { InvariantError } from './errors';
import type { Capability } from './provider';

export type ModelKind = 'diffusion' | 'lora' | 'tool';

export type PricingSpec = {
  unit: 'usd' | 'credit' | 'token' | 'free';
  rate: number;
  per: 'call' | 'second' | 'minute' | 'megapixel';
  /** Когда тариф подтверждён. Для локальных — дата проверки установки. */
  verifiedOn: string;
  sourceNote: string;
};

export type ModelSpec = {
  /** Стабильный ключ. Не меняется никогда: на него ссылается provenance. */
  key: string;
  provider: string;
  capability: Capability | 'assemble';
  kind: ModelKind;
  runtime: 'local' | 'api';
  /** Имя файла или идентификатор, которым модель зовут на стороне провайдера. */
  target: string;
  /** Версия. Для локальных весов — размер файла: он меняется при подмене. */
  version: string;
  pricing: PricingSpec;
  determinism: {
    seedSupported: boolean;
    /**
     * Даёт ли один и тот же seed один и тот же результат.
     *
     * Три состояния, и null среди них полноправное: «не проверено» — это не
     * «наверное да». На воспроизводимости строится весь смысл реестра, и
     * объявлять её без измерения нельзя ни в ту, ни в другую сторону.
     *
     * Проверяется повторным запуском с тем же seed и сравнением отпечатков.
     * Важная тонкость измерения: ComfyUI кэширует исполнение, и повтор
     * побайтово того же графа вернёт прежний файл, не считая ничего. Такой
     * повтор измеряет кэш, а не модель. Настоящий замер требует сброса кэша —
     * перезапуска сервера между запусками.
     */
    seedStable: boolean | null;
  };
  /**
   * Как модель ломается. Только то, что уже проверено на этом проекте и
   * записано в его документах, — не общие сведения из интернета.
   */
  knownFailureModes: readonly string[];
  enabled: boolean;
};

const LOCAL_FREE: PricingSpec = {
  unit: 'free',
  rate: 0,
  per: 'call',
  verifiedOn: '2026-08-12',
  sourceNote: 'локальный ComfyUI на RTX 5080: долларов не тратит, тратит время GPU'
};

export const MODELS: readonly ModelSpec[] = [
  {
    key: 'comfyui/qwen-image-edit-2509',
    provider: 'comfyui',
    capability: 'image-edit',
    kind: 'diffusion',
    runtime: 'local',
    target: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
    version: 'fp8_e4m3fn/20430698424',
    pricing: LOCAL_FREE,
    determinism: { seedSupported: true, seedStable: false },
    knownFailureModes: [
      'Отъезжает камерой: из плотного кадра делает средний план. ' +
        'Перечислять, что режется краями (СТАТУС.md, «Грабли»).',
      'Одна правка за проход: не поворачивать и не чинить фон одновременно ' +
        '(СТАТУС.md, «Грабли»).',
      'Считаемые детали надо писать числом: «ровно три мухомора», «два листа» ' +
        '(СТАТУС.md, «Грабли»).',
      'Формулировка «pure black eyes with no iris» уводит генерацию от эталонов ' +
        'и запрещена (CAST.md, п.5).',
      'Один и тот же seed НЕ даёт один и тот же файл. Измерено 12.08.2026: два ' +
        'запуска с одинаковыми seed, референсом, графом, параметрами и ' +
        'окружением дали 2af4d258… и 5dbdca7d…, 1 215 154 и 1 216 058 байт при ' +
        'одинаковом кадре 880×1184 (docs/CE-TASK-003B.md).'
    ],
    enabled: true
  },
  {
    key: 'comfyui/qwen-edit-2509-multiple-angles',
    provider: 'comfyui',
    capability: 'image-edit',
    kind: 'lora',
    runtime: 'local',
    target: 'Qwen-Edit-2509-Multiple-angles.safetensors',
    version: '236117032',
    pricing: LOCAL_FREE,
    determinism: { seedSupported: true, seedStable: false },
    knownFailureModes: [
      'Нокс: череп надет маской поверх головы. При повороте модель прирастит ' +
        'его к голове или потеряет лицо под ним (СТАТУС.md, «Грабли»).',
      'Камера рулится фразами на китайском: 将镜头向左旋转45度 — ¾ слева, ' +
        '将镜头向右旋转45度 — ¾ справа, 将镜头旋转180度，从背后拍摄 — затылок ' +
        '(СТАТУС.md, «Следующий шаг»).'
    ],
    enabled: true
  },
  {
    key: 'comfyui/qwen-image-edit-2509-lightning-4steps',
    provider: 'comfyui',
    capability: 'image-edit',
    kind: 'lora',
    runtime: 'local',
    target: 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors',
    version: '849608296',
    pricing: LOCAL_FREE,
    determinism: { seedSupported: true, seedStable: false },
    knownFailureModes: [],
    enabled: true
  },
  {
    key: 'ffmpeg/cli',
    provider: 'ffmpeg',
    capability: 'assemble',
    kind: 'tool',
    runtime: 'local',
    target: 'ffmpeg',
    version: '8.1.2',
    pricing: LOCAL_FREE,
    determinism: { seedSupported: false, seedStable: true },
    knownFailureModes: [],
    enabled: true
  }
];

export function findModel(key: string): ModelSpec | null {
  return MODELS.find((model) => model.key === key) ?? null;
}

export function requireModel(key: string): ModelSpec {
  const model = findModel(key);
  if (!model) {
    throw new InvariantError(
      `Модели ${key} нет в реестре. Известные: ${MODELS.map((m) => m.key).join(', ')}.`
    );
  }
  return model;
}
