/**
 * Ракурсы персонажа: как о них просят модель и куда кладут результат.
 *
 * Фразы камеры — на китайском, и это не экзотика: LoRA
 * `Qwen-Edit-2509-Multiple-angles` обучена именно на них, а перевод на
 * английский поворота не даёт. Формулировки взяты из `СТАТУС.md`, раздел
 * «Следующий шаг — ракурсы», дословно.
 *
 * КОНВЕНЦИЯ ИМЁН — ОБЪЕКТНАЯ. Принята 13.08.2026 по результату двух запусков.
 *
 *   three-quarter-left   — видна ЛЕВАЯ сторона самого персонажа
 *   three-quarter-right  — видна ПРАВАЯ сторона самого персонажа
 *
 * Имя описывает результат, а не движение камеры, и поэтому привязка к фразе
 * ПЕРЕКРЁСТНАЯ: «повернуть камеру влево» показывает правую сторону персонажа.
 * Первые два ракурса Москина были названы по камере и оказались зеркально
 * перепутаны — разбор в `docs/CE-TASK-003B.md`.
 *
 * Кириллицы в промпте нет и быть не может: модели её перевирают, и правило
 * `no-cyrillic-in-generation` это прямо запрещает.
 */
import { InvariantError } from '@core/index';

export type TurnaroundAngle = 'three-quarter-left' | 'three-quarter-right' | 'back';

export type AngleSpec = {
  angle: TurnaroundAngle;
  /** Фраза камеры, которую понимает LoRA. */
  cameraPhrase: string;
  /** Как ракурс называется человеку. */
  label: string;
};

export const ANGLES: readonly AngleSpec[] = [
  {
    angle: 'three-quarter-left',
    // Камеру ВПРАВО — чтобы стала видна ЛЕВАЯ сторона персонажа. Привязка
    // перекрёстная, и это не опечатка: см. объектную конвенцию выше.
    cameraPhrase: '将镜头向右旋转45度',
    label: '¾ слева (видна левая сторона персонажа)'
  },
  {
    angle: 'three-quarter-right',
    cameraPhrase: '将镜头向左旋转45度',
    label: '¾ справа (видна правая сторона персонажа)'
  },
  {
    angle: 'back',
    cameraPhrase: '将镜头旋转180度，从背后拍摄',
    label: 'затылок'
  }
];

export function requireAngle(angle: string): AngleSpec {
  const spec = ANGLES.find((candidate) => candidate.angle === angle);
  if (!spec) {
    throw new InvariantError(
      `Неизвестный ракурс: ${angle}. Известные: ${ANGLES.map((a) => a.angle).join(', ')}.`
    );
  }
  return spec;
}

/**
 * Словарь допустимых значений `Asset.cameraAngle`.
 *
 * Выводится из ANGLES, а не пишется вторым списком рядом: два списка одних и тех
 * же значений неизбежно разойдутся, и разойдутся молча.
 *
 * Список открыт и расширяется правкой ANGLES, без миграции — ровно поэтому
 * ракурс хранится строкой, а не перечислением. Расширять придётся: `CAST.md`
 * числит несделанным `ref_side.png` («боковой ракурс… ни у кого»), а у Нокса и
 * Эхо ракурс-подпись — полупрофиль и профиль. В текущий заход они не входят
 * (`СТАТУС.md`: «не чистые профили — они в кадре почти не нужны»), поэтому и
 * значений для них здесь пока нет: словарь описывает то, что движок умеет
 * произвести, а не то, что когда-нибудь понадобится.
 */
export const CAMERA_ANGLES: readonly string[] = ANGLES.map((spec) => spec.angle);

export function isCameraAngle(value: string): value is TurnaroundAngle {
  return CAMERA_ANGLES.includes(value);
}

export function assertCameraAngle(value: string): asserts value is TurnaroundAngle {
  if (!isCameraAngle(value)) {
    throw new InvariantError(
      `Неизвестный ракурс: ${value}. Допустимые: ${CAMERA_ANGLES.join(', ')}.`
    );
  }
}

/**
 * Ракурс по фразе камеры — обратный разбор.
 *
 * Нужен там, где ракурс приходится ВОССТАНАВЛИВАТЬ из записи о прошлом:
 * в параметрах запуска сохранена фраза, а не название ракурса. Прямой путь
 * (название → фраза) остаётся единственным при генерации; этот — только для
 * сверки уже записанного.
 */
export function findAngleByCameraPhrase(phrase: string): AngleSpec | null {
  return ANGLES.find((spec) => spec.cameraPhrase === phrase) ?? null;
}

/**
 * Ограничения канона, добавляемые к каждому промпту ракурса.
 *
 * Каждая строка — не украшение, а закрытие известного отказа:
 *
 *   1-2  Qwen отъезжает камерой и превращает плотный кадр в средний план
 *        (СТАТУС.md, «Грабли»). Поэтому кадрирование описывается явно.
 *   3    Канон лица: радужка с кольцом, зрачок, блик, брови-запятые
 *        (CAST.md, п.5). Формулировка «pure black eyes with no iris»
 *        запрещена и здесь не используется.
 *   4    Рта нет (CAST.md, п.5).
 *   5    Кириллицу и любой текст в кадр не генерировать (CAST.md, п.6).
 *   6    Один персонаж: лишние фигуры ломают силуэтный тест.
 */
export const CANON_GUARDS: readonly string[] = [
  'Keep the full figure inside the frame, head and feet not cropped.',
  'Keep the same close framing and the same plain white background; do not zoom out to a medium shot.',
  'Keep the eyes exactly as in the reference: huge and round, with a warm iris ring, a dark pupil and a bright highlight, and two tiny dark comma eyebrows.',
  'The character has no mouth; do not add one.',
  'No text, no letters, no numbers, no watermark anywhere in the image.',
  'Exactly one character in the frame, no extra figures.'
];

/**
 * Собрать промпт ракурса.
 *
 * Строка персонажа вставляется ДОСЛОВНО, вместе с её разметкой: в паспорте
 * прямо написано «копировать дословно», и любая чистка увела бы генерацию от
 * эталона. Правится только то, что относится к камере и к рамкам канона.
 */
export function buildTurnaroundPrompt(promptLine: string, spec: AngleSpec): string {
  return [
    spec.cameraPhrase,
    'Keep the same character with the same design, colours, proportions and silhouette:',
    promptLine,
    ...CANON_GUARDS
  ].join(' ');
}

/** Путь результата. Seed в имени: два дубля одного ракурса не столкнутся. */
export function turnaroundPath(slug: string, angle: TurnaroundAngle, seed: string): string {
  return `characters/${slug}/turnaround/${angle}.s${seed}.png`;
}
