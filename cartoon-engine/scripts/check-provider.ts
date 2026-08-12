/**
 * Проверка провайдерского слоя: CE-TASK-003B.
 *
 * Генерации не запускает и ComfyUI не требует — работает с тем, что уже
 * записано в реестре. Отвечает на один вопрос: можно ли по записи ассета
 * понять, что именно было запущено.
 *
 *   npm run check:provider
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import {
  findModel,
  getEngineDb,
  listAssets,
  MediaStore,
  MODELS,
  requireModel,
  type AssetView
} from '@core/index';
import { isAssetRole } from '../apps/cartoon/src/domain/roles';
import {
  ANGLES,
  CAMERA_ANGLES,
  findAngleByCameraPhrase,
  isCameraAngle
} from '../apps/cartoon/src/domain/turnaround';
import {
  TURNAROUND_LORA_KEYS,
  TURNAROUND_MODEL_KEY,
  TURNAROUND_ROLE
} from '../apps/cartoon/src/services/turnaround-generate';

const passed: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`Провалилась проверка: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
  passed.push(label);
}

async function main(): Promise<void> {
  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    // --- реестр моделей ------------------------------------------------------
    check('роль turnaround в словаре', isAssetRole(TURNAROUND_ROLE));
    check('базовая модель в реестре', findModel(TURNAROUND_MODEL_KEY) !== null);
    for (const key of TURNAROUND_LORA_KEYS) {
      check(`LoRA в реестре: ${key}`, findModel(key) !== null);
    }
    check('ffmpeg в реестре', findModel('ffmpeg/cli') !== null);
    check('ключи моделей уникальны', new Set(MODELS.map((m) => m.key)).size === MODELS.length);
    check(
      'у локальных моделей стоимость помечена бесплатной',
      MODELS.filter((m) => m.runtime === 'local').every((m) => m.pricing.unit === 'free')
    );
    check(
      'устойчивость seed у Qwen измерена и равна false',
      requireModel(TURNAROUND_MODEL_KEY).determinism.seedStable === false,
      'измерено 12.08.2026: два запуска с одинаковым seed дали разные файлы'
    );
    for (const key of TURNAROUND_LORA_KEYS) {
      check(
        `устойчивость seed измерена и у LoRA: ${key}`,
        requireModel(key).determinism.seedStable === false
      );
    }
    check(
      'ни одна модель не объявлена воспроизводимой без измерения',
      MODELS.every((m) => m.determinism.seedStable !== null)
    );
    check(
      'известные отказы описаны и взяты из документов проекта',
      requireModel(TURNAROUND_MODEL_KEY).knownFailureModes.length > 0
    );
    check('ракурсов ровно три', ANGLES.length === 3);
    check(
      'ни в одной фразе камеры нет кириллицы',
      ANGLES.every((angle) => !/[а-яё]/i.test(angle.cameraPhrase))
    );
    check(
      'словарь ракурсов выведен из ANGLES, а не написан вторым списком',
      CAMERA_ANGLES.length === ANGLES.length &&
        ANGLES.every((angle) => isCameraAngle(angle.angle))
    );
    check(
      'фразы камеры различимы: по фразе восстанавливается ровно её ракурс',
      ANGLES.every((angle) => findAngleByCameraPhrase(angle.cameraPhrase)?.angle === angle.angle)
    );

    // --- сгенерированные ассеты ---------------------------------------------
    const assets = await listAssets(db);
    const generated = assets.filter((asset) => asset.provenance?.producedBy === 'provider');

    check('есть хотя бы один ассет, произведённый провайдером', generated.length > 0);

    for (const asset of generated) {
      const p = asset.provenance;
      const at = asset.relativePath;

      check(`файл существует: ${at}`, await store.exists(at));
      check(`роль из словаря: ${at}`, asset.role !== null && isAssetRole(asset.role));
      check(`привязан к персонажу: ${at}`, asset.characterId !== null);
      check(`sha256 записан: ${at}`, /^[0-9a-f]{64}$/.test(asset.sha256));
      check(`размеры кадра прочитаны: ${at}`, asset.width !== null && asset.height !== null);

      check(`провайдер записан: ${at}`, !!p?.providerId);
      check(`модель записана: ${at}`, !!p?.modelKey);
      check(`модель есть в реестре: ${at}`, findModel(p?.modelKey ?? '') !== null);
      check(`версия модели записана: ${at}`, !!p?.modelVersion);
      check(`промпт записан: ${at}`, !!p?.prompt && p.prompt.length > 20);
      check(`seed записан: ${at}`, !!p?.seed && /^\d+$/.test(p.seed));
      check(`параметры записаны: ${at}`, !!p?.parameters);
      check(`отпечаток workflow записан: ${at}`, /^[0-9a-f]{64}$/.test(p?.workflowHash ?? ''));
      check(`текст workflow сохранён целиком: ${at}`, !!p?.workflowJson);
      check(
        `текст workflow сходится со своим отпечатком: ${at}`,
        createHash('sha256').update(p?.workflowJson ?? '', 'utf8').digest('hex') ===
          p?.workflowHash,
        'граф в базе не соответствует записанному хешу — восстановить запуск нельзя'
      );
      check(`сохранённый workflow разбирается как граф: ${at}`, (() => {
        try {
          const graph = JSON.parse(p?.workflowJson ?? 'null') as Record<string, unknown>;
          return !!graph && Object.keys(graph).length > 0;
        } catch {
          return false;
        }
      })());
      check(`дескриптор запуска записан: ${at}`, !!p?.providerRunRef);
      check(
        `отпечаток окружения записан: ${at}`,
        /^[0-9a-f]{64}$/.test(p?.envFingerprintHash ?? '')
      );
      check(`окружение читается как JSON: ${at}`, (() => {
        try {
          const env = JSON.parse(p?.envFingerprint ?? 'null') as Record<string, unknown>;
          return !!env && typeof env === 'object' && 'comfyuiVersion' in env && 'models' in env;
        } catch {
          return false;
        }
      })());
      check(`расход записан: ${at}`, !!p?.spend);
      check(`доллары признаны нулевыми, а не неизвестными: ${at}`, (() => {
        try {
          return (JSON.parse(p?.spend ?? '{}') as { usd?: unknown }).usd === 0;
        } catch {
          return false;
        }
      })());

      check(
        `воспроизводимость вычислена, а не unknown: ${at}`,
        p?.reproducibility === 'stochastic' || p?.reproducibility === 'deterministic',
        `получено ${p?.reproducibility}`
      );
      check(`причина класса записана: ${at}`, !!p?.note && p.note.length > 0);

      check(`вход записан: ${at}`, asset.inputs.length > 0);
      check(
        `вход имеет роль reference: ${at}`,
        asset.inputs.some((link) => link.role === 'reference')
      );

      const referenceLink = asset.inputs.find((link) => link.role === 'reference');
      const referenceAsset: AssetView | undefined = assets.find(
        (candidate) => candidate.id === referenceLink?.inputAssetId
      );
      check(`вход указывает на существующий ассет: ${at}`, referenceAsset !== undefined);
      check(
        `вход — эталон того же персонажа: ${at}`,
        referenceAsset?.role === 'ref-front' &&
          referenceAsset.characterId === asset.characterId
      );
      check(
        `вход существует на диске: ${at}`,
        referenceAsset !== undefined && (await store.exists(referenceAsset.relativePath))
      );
      check(
        `результат не перезаписал вход: ${at}`,
        referenceAsset !== undefined && referenceAsset.relativePath !== asset.relativePath
      );
      check(
        `результат и вход — разные байты: ${at}`,
        referenceAsset !== undefined && referenceAsset.sha256 !== asset.sha256
      );
    }

    // --- ракурсы различимы ---------------------------------------------------
    //
    // До появления cameraAngle ракурс жил в имени файла, и вопрос «текущий
    // turnaround персонажа» отвечался тем, чей путь меньше по алфавиту. Здесь
    // проверяется, что ракурс стал фактом строки и что три источника — поле,
    // фраза камеры и путь — говорят одно и то же.
    const turnarounds = assets.filter((asset) => asset.role === TURNAROUND_ROLE);

    for (const asset of turnarounds) {
      const at = asset.relativePath;
      const angle = asset.cameraAngle;

      check(`ракурс проставлен: ${at}`, angle !== null, 'npm run backfill:camera-angle');
      check(
        `ракурс из словаря: ${at}`,
        angle !== null && isCameraAngle(angle),
        `получено ${angle}, допустимые: ${CAMERA_ANGLES.join(', ')}`
      );

      const phrase = (() => {
        try {
          const parsed = JSON.parse(asset.provenance?.parameters ?? '{}') as {
            cameraPhrase?: unknown;
          };
          return typeof parsed.cameraPhrase === 'string' ? parsed.cameraPhrase : null;
        } catch {
          return null;
        }
      })();

      check(
        `ракурс согласован с фразой камеры: ${at}`,
        phrase === null || findAngleByCameraPhrase(phrase)?.angle === angle,
        `поле ${angle}, а фраза ${phrase} означает ${findAngleByCameraPhrase(phrase ?? '')?.angle}`
      );
      check(
        `ракурс согласован с именем файла: ${at}`,
        angle !== null && (at.split('/').pop() ?? '').startsWith(`${angle}.`)
      );
    }

    check(
      'разные ракурсы не являются версиями друг друга',
      turnarounds.every((asset) => asset.supersedesId === null),
      'у ракурса появился supersedesId — версия и дубль перепутаны'
    );

    // Ролям без ракурса пустое значение не запрещено: применимость выводится из
    // роли, и у клипа ракурса нет, потому что это клип.
    check(
      'эталоны, карточки и клипы живут без ракурса',
      assets
        .filter((asset) => ['ref-front', 'card', 'clip'].includes(asset.role ?? ''))
        .every((asset) => asset.cameraAngle === null)
    );

    // --- импортированные не притворяются произведёнными ----------------------
    const imported = assets.filter((asset) => asset.provenance?.producedBy === 'import');
    check(
      'у импортированных нет провайдера и модели',
      imported.every(
        (asset) => !asset.provenance?.providerId && !asset.provenance?.modelKey
      )
    );
    check(
      'у импортированных воспроизводимость осталась unknown',
      imported.every((asset) => asset.provenance?.reproducibility === 'unknown')
    );
    check('у импортированных нет входов', imported.every((asset) => asset.inputs.length === 0));

    console.log(`Пройдено проверок: ${passed.length}`);
    console.log('check:provider — OK');
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
