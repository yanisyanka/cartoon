/**
 * Вырезать задний эталон персонажа из его каноничного клипа.
 *
 * Клип каждого духа — оборот на 360°, и вид сзади в нём уже снят. Это не
 * реконструкция и не догадка: кадр берётся из материала, который существовал до
 * движка и лежит в реестре с ролью `clip`. Ничего не дорисовывается.
 *
 * Почему не генерацией. Модель, получив только фронтальный эталон, домысливает
 * корпус со спины — со фронта не видно ни того, как лежит накидка, ни того, что
 * происходит с руками и ногами. Сгенерированный затылок может совпасть с
 * каноном, но источником истины он быть не может: он и есть то, что мы
 * собирались проверять.
 *
 * Почему не руками. Дорисованный эталон сделал бы `producedBy = human`, а
 * оттуда `hasHumanAncestor` красит в `human-touched` ВСЁ, что из него потом
 * произведут. Ручной шаг в начале цепочки стоит дороже, чем кажется.
 *
 * Кадр выбирает человек и передаёт номером. Автоматического выбора здесь нет
 * намеренно: «настоящие 180°» — суждение о картинке, и принимать его должен
 * тот, кто на неё смотрит.
 *
 * Повторный запуск заменяет эталон, а не дополняет его. Суждение о 180° человек
 * может пересмотреть — так и вышло с Твиглетом, у которого выбранный кадр
 * оказался в 18° от затылка, — и тогда нужна версия, а не второй эталон рядом.
 * Новые байты ложатся на путь предыдущей версии через `replaceExisting`, строка
 * предыдущей остаётся в реестре нетронутой и связывается через `supersedesId`.
 *
 *   npm run extract:back-ref -- <slug> --frame <N>
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  assertValidProvenance,
  computeReproducibility,
  createAssetWithProvenance,
  explainReproducibility,
  findCurrentAssetByCharacterAndRole,
  getEngineDb,
  InvariantError,
  MediaStore,
  requireModel,
  type ReproducibilityFacts
} from '@core/index';
import { findCharacterBySlug } from '../apps/cartoon/src/repositories/characters';
import { assertAssetRole } from '../apps/cartoon/src/domain/roles';
import { fingerprintHash } from '../apps/cartoon/src/services/turnaround-generate';

const run = promisify(execFile);

/** Роль результата. Именно эталон, а не ракурс: на него будут ссылаться. */
const BACK_REFERENCE_ROLE = 'ref-back';
/** Роль клипа как входа. Не `reference`: кадр из него вырезан, а не порождён. */
const SOURCE_INPUT_ROLE = 'source';
const CLIP_ROLE = 'clip';
const FFMPEG_MODEL_KEY = 'ffmpeg/cli';

/** Версия ffmpeg из него самого, а не из реестра: сверяются они ниже. */
async function ffmpegVersion(): Promise<string> {
  const { stdout } = await run('ffmpeg', ['-version'], { maxBuffer: 1 << 20 });
  const match = /^ffmpeg version (\S+)/.exec(stdout);
  if (!match?.[1]) {
    throw new InvariantError('Не удалось прочитать версию ffmpeg.');
  }
  return match[1];
}

/** Один кадр по точному номеру, PNG в stdout. Файлов на диске не оставляет. */
async function extractFrame(source: string, frameIndex: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', source,
      '-vf', `select=eq(n\\,${frameIndex})`,
      '-frames:v', '1',
      '-f', 'image2',
      '-c:v', 'png',
      '-'
    ],
    { encoding: 'buffer', maxBuffer: 64 << 20 }
  );

  const bytes = Buffer.from(stdout);
  if (bytes.length === 0) {
    throw new InvariantError(
      `ffmpeg вернул пустой результат для кадра ${frameIndex}. ` +
        'Скорее всего, такого кадра в клипе нет.'
    );
  }
  return bytes;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const slug = argv.find((arg) => !arg.startsWith('--'));
  const frameRaw = argv[argv.indexOf('--frame') + 1];

  if (!slug || argv.indexOf('--frame') < 0 || !/^\d+$/.test(frameRaw ?? '')) {
    console.error(
      'Использование: npm run extract:back-ref -- <slug> --frame <N>\n' +
        'Номер кадра обязателен: выбор «настоящих 180°» — решение человека.'
    );
    process.exitCode = 1;
    return;
  }

  const frameIndex = Number(frameRaw);
  assertAssetRole(BACK_REFERENCE_ROLE);

  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    // --- 1. персонаж и его клип ---------------------------------------------
    const character = await findCharacterBySlug(db, slug);
    if (!character) {
      throw new InvariantError(`Персонажа ${slug} в базе нет.`);
    }

    const clip = await findCurrentAssetByCharacterAndRole(db, character.id, CLIP_ROLE);
    if (!clip) {
      throw new InvariantError(`У персонажа ${slug} нет клипа с ролью ${CLIP_ROLE}.`);
    }

    // Отпечаток пересчитывается с диска: вырезаем кадр из того файла, который
    // реестр считает клипом, а не из того, что просто лежит по этому пути.
    const onDisk = await store.describe(clip.relativePath);
    if (onDisk.sha256 !== clip.sha256) {
      throw new InvariantError(
        `${clip.relativePath} на диске имеет отпечаток ${onDisk.sha256}, ` +
          `а в реестре записан ${clip.sha256}. Остановка.`
      );
    }

    console.log(`Источник: ${clip.relativePath}`);
    console.log(`  sha256 ${clip.sha256}`);
    console.log(`  кадр   ${frameIndex}\n`);

    // --- 2. модель и её версия ----------------------------------------------
    const model = requireModel(FFMPEG_MODEL_KEY);
    const version = await ffmpegVersion();
    if (!version.startsWith(model.version)) {
      throw new InvariantError(
        `В реестре записан ffmpeg ${model.version}, а установлен ${version}. ` +
          'Реестр описывает то, чем работали, — расхождение надо разобрать, а не обойти.'
      );
    }

    // --- 3. путь результата: тот же, что у предыдущей версии ----------------
    // Версия в этой модели — тот же путь и другие байты, а «текущий эталон»
    // ищется группировкой по пути. Положить новую версию рядом означало бы
    // завести у персонажа два текущих задних эталона, из которых запрос вернул
    // бы тот, чей путь меньше по алфавиту, то есть устаревший.
    const outputPath = `characters/${character.slug}/ref_back.png`;
    const current = await findCurrentAssetByCharacterAndRole(
      db,
      character.id,
      BACK_REFERENCE_ROLE
    );

    if (current && current.relativePath !== outputPath) {
      throw new InvariantError(
        `Текущий задний эталон записан по пути ${current.relativePath}, ` +
          `а не ${outputPath}. Новая версия обязана лечь на путь предыдущей.`
      );
    }
    if (!current && (await store.exists(outputPath))) {
      throw new InvariantError(
        `${outputPath} лежит на диске, но в реестре его нет. ` +
          'Сначала разберите расхождение, потом заменяйте.'
      );
    }

    // --- 4. извлечение -------------------------------------------------------
    const bytes = await extractFrame(store.resolve(clip.relativePath), frameIndex);

    // Тот же кадр заменять нечем: отпечаток уникален глобально, и попытка
    // записать существующие байты второй строкой всё равно уперлась бы в базу —
    // лучше сказать это словами, чем нарушением ограничения.
    if (current && createHash('sha256').update(bytes).digest('hex') === current.sha256) {
      throw new InvariantError(
        `Кадр ${frameIndex} уже является текущим задним эталоном ` +
          `(версия ${current.version}, ${current.sha256}). Заменять нечем.`
      );
    }

    const facts = current
      ? await store.replaceExisting(outputPath, bytes)
      : await store.receive(outputPath, bytes);

    // --- 5. происхождение ----------------------------------------------------
    const parameters = {
      frameIndex,
      filter: `select=eq(n,${frameIndex})`,
      sourceRelativePath: clip.relativePath,
      sourceSha256: clip.sha256
    };

    const envFingerprint = {
      ffmpegVersion: version,
      os: process.platform,
      sourceSha256: clip.sha256,
      frameIndex
    };
    const envHash = fingerprintHash(envFingerprint);

    // Класс считает система, как и для всего остального. Здесь он выходит
    // заниженным, и это записано прямо в причине: извлечение кадра
    // детерминировано побайтово, но правило требует seed и отпечаток workflow,
    // которых у кадрореза нет и быть не может. Подменять расчёт руками нельзя —
    // тогда класс перестанет быть вычисляемым; пересмотр правила отдельная
    // задача.
    const reproducibilityFacts: ReproducibilityFacts = {
      producedBy: 'provider',
      runtime: model.runtime,
      seedStable: model.determinism.seedStable,
      seedRecorded: false,
      envFingerprintRecorded: envHash.length > 0,
      workflowRecorded: false,
      hasHumanAncestor: clip.provenance?.producedBy === 'human'
    };

    const provenance = {
      producedBy: 'provider' as const,
      reproducibility: computeReproducibility(reproducibilityFacts),
      note:
        `${explainReproducibility(reproducibilityFacts)}. ` +
        'Класс занижен: извлечение кадра по номеру детерминировано побайтово, ' +
        'но правило требует seed и отпечаток workflow, которых у кадрореза нет.',
      providerId: 'ffmpeg',
      modelKey: model.key,
      modelVersion: version,
      prompt: null,
      seed: null,
      parameters: JSON.stringify(parameters),
      workflowHash: null,
      workflowJson: null,
      providerRunRef: null,
      envFingerprint: JSON.stringify(envFingerprint),
      envFingerprintHash: envHash,
      spend: JSON.stringify({ usd: 0, credits: null, tokens: null, settled: true })
    };
    assertValidProvenance(provenance);

    const asset = await createAssetWithProvenance(db, {
      relativePath: facts.relativePath,
      type: facts.type,
      mimeType: facts.mimeType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      width: facts.width,
      height: facts.height,
      role: BACK_REFERENCE_ROLE,
      // Ракурс у эталона такой же полноправный, как у ракурса: словарь уже
      // знает `back`, и заводить для эталона отдельное понятие не нужно.
      cameraAngle: 'back',
      characterId: character.id,
      // Прежняя строка не трогается: она остаётся историей и по-прежнему
      // описывает те байты, которыми была. Расхождение её отпечатка с диском
      // после замены — не порча, а обычное состояние перекрытой версии.
      version: current ? current.version + 1 : 1,
      supersedesId: current?.id ?? null,
      provenance,
      inputs: [{ inputAssetId: clip.id, role: SOURCE_INPUT_ROLE }]
    });

    console.log(`Готово: ${asset.relativePath}`);
    console.log(`  роль     ${asset.role} · ракурс ${asset.cameraAngle}`);
    console.log(`  кадр     ${asset.width}×${asset.height} · ${asset.sizeBytes} байт`);
    console.log(`  sha256   ${asset.sha256}`);
    console.log(`  версия   ${asset.version} · supersedes ${asset.supersedesId ?? 'null'}`);
    if (current) {
      console.log(`  заменил  версию ${current.version} (${current.id}), её строка не изменена`);
      console.log(`           её отпечаток ${current.sha256} остаётся в реестре как история`);
    }
    console.log(`  из       ${clip.relativePath} (роль ${SOURCE_INPUT_ROLE})`);
    console.log(`  класс    ${asset.provenance?.reproducibility}`);
    console.log(`  причина  ${asset.provenance?.note}`);
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
