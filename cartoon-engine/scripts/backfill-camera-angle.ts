/**
 * Проставить ракурс ассетам, сделанным до появления поля `Asset.cameraAngle`.
 *
 * Нужно ровно один раз: первый ракурс Москина сделан тогда, когда ракурс жил
 * только в имени файла и в свободном JSON параметров запуска.
 *
 * Догадок здесь нет. Ракурс восстанавливается ТРЕМЯ независимыми способами:
 *
 *   1. путь            three-quarter-left.s20260812.png → three-quarter-left
 *   2. filename_prefix turnaround_01-mossy_three-quarter-left → …-left
 *   3. cameraPhrase    将镜头向左旋转45度 → обратный поиск в ANGLES
 *
 * Все три обязаны дать одно и то же значение. Разошлись хоть в чём-то — скрипт
 * отказывается и не трогает строку: три источника расходятся только если файл
 * переименовали, параметры правили или словарь ракурсов сдвинулся, и в каждом из
 * этих случаев запись о прошлом надо читать глазами, а не чинить автоматически.
 *
 * Берутся ТОЛЬКО строки с пустым ракурсом. Заполненные не пересматриваются, и
 * это не оптимизация: правило трёх источников само конвенционно. Путь и
 * filename_prefix заморожены в тот момент, когда их записали, а cameraPhrase
 * читается через текущий словарь ANGLES — после смены конвенции имён
 * (13.08.2026, объектная) на старых записях они расходятся навсегда. Сверять по
 * ним уже классифицированное значило бы каждый раз получать ложный отказ.
 *
 * Исправление уже проставленного ракурса — не дело этого скрипта: см.
 * scripts/apply-object-camera-convention.ts, адресный и одноразовый.
 *
 * Идемпотентность не приделана сбоку, а взята из classifyAsset: он заполняет
 * только пустое и отказывается переписывать уже проставленное.
 *
 *   npm run backfill:camera-angle
 */
import 'dotenv/config';
import { classifyAsset, getEngineDb, listAssets, type AssetView } from '@core/index';
import {
  CAMERA_ANGLES,
  findAngleByCameraPhrase,
  isCameraAngle
} from '../apps/cartoon/src/domain/turnaround';
import { TURNAROUND_ROLE } from '../apps/cartoon/src/services/turnaround-generate';

/** Ракурс из имени файла: `<ракурс>.s<seed>.png`. */
function angleFromPath(relativePath: string): string | null {
  const fileName = relativePath.split('/').pop() ?? '';
  const candidate = fileName.split('.')[0] ?? '';
  return isCameraAngle(candidate) ? candidate : null;
}

/**
 * Ракурс из префикса имён у провайдера: `turnaround_<slug>_<ракурс>`.
 *
 * Разбирается не позицией, а поиском по словарю: позиция зависит от того, есть
 * ли в slug подчёркивания, а окончание — не зависит. Совпасть должен ровно один
 * ракурс: два совпадения означали бы, что словарь неоднозначен.
 */
function angleFromPrefix(prefix: string): string | null {
  const matches = CAMERA_ANGLES.filter((angle) => prefix.endsWith(`_${angle}`));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function angleFromPhrase(phrase: string): string | null {
  return findAngleByCameraPhrase(phrase)?.angle ?? null;
}

type Sources = {
  path: string | null;
  prefix: string | null;
  phrase: string | null;
};

function readSources(asset: AssetView): Sources {
  let parameters: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(asset.provenance?.parameters ?? '{}');
    if (parsed && typeof parsed === 'object') parameters = parsed as Record<string, unknown>;
  } catch {
    parameters = {};
  }

  const prefix = parameters['filename_prefix'];
  const phrase = parameters['cameraPhrase'];

  return {
    path: angleFromPath(asset.relativePath),
    prefix: typeof prefix === 'string' ? angleFromPrefix(prefix) : null,
    phrase: typeof phrase === 'string' ? angleFromPhrase(phrase) : null
  };
}

function describe(sources: Sources): string {
  return (
    `      путь            ${sources.path ?? '—'}\n` +
    `      filename_prefix ${sources.prefix ?? '—'}\n` +
    `      cameraPhrase    ${sources.phrase ?? '—'}`
  );
}

async function main(): Promise<void> {
  const db = getEngineDb();

  try {
    const turnarounds = (await listAssets(db)).filter(
      (asset) => asset.role === TURNAROUND_ROLE && asset.cameraAngle === null
    );

    if (turnarounds.length === 0) {
      console.log('Ракурсов без проставленного угла нет — проставлять нечего.');
      return;
    }

    let filled = 0;
    let alreadyRight = 0;
    let refused = 0;

    for (const asset of turnarounds) {
      const sources = readSources(asset);
      const values = [sources.path, sources.prefix, sources.phrase];
      const agreed = values.every((value) => value !== null && value === values[0]);

      if (!agreed) {
        console.error(
          `  ✗ ${asset.relativePath}\n` +
            '      три источника расходятся, ракурс не проставлен:\n' +
            `${describe(sources)}`
        );
        refused += 1;
        continue;
      }

      const angle = values[0] as string;

      if (asset.cameraAngle === angle) {
        console.log(`  = ${asset.relativePath} — уже ${angle}, не тронут`);
        alreadyRight += 1;
        continue;
      }

      // classifyAsset откажется переписать ракурс, если он проставлен другим:
      // расхождение записи с источниками — повод посмотреть глазами, а не
      // повод для тихой правки.
      const { changed } = await classifyAsset(db, asset.id, { cameraAngle: angle });
      console.log(
        `  ✓ ${asset.relativePath} — ракурс ${angle}` +
          `${changed ? '' : ' (запись не изменилась)'}`
      );
      console.log(`${describe(sources)}`);
      filled += 1;
    }

    console.log(
      `\nПроставлено: ${filled} · уже верных: ${alreadyRight} · ` +
        `отказов: ${refused} · ракурсов без угла было: ${turnarounds.length}`
    );
    if (refused > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${name}: ${message}`);
  process.exitCode = 1;
});
