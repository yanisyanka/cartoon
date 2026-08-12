/**
 * Метаданные видео через ffprobe.
 *
 * Живёт в приложении, а не в ядре: ядро внешних программ не запускает — иначе
 * его поведение зависело бы от того, что установлено на машине. Здесь такая
 * зависимость допустима и объявлена: нет ffprobe — нет метаданных, и это
 * сообщается честно, а не подменяется догадкой.
 *
 * Вызов строго читающий. ffprobe разбирает контейнер и печатает JSON; ключа,
 * который заставил бы его писать в файл, здесь нет.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type VideoFacts = {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
  fps: number | null;
};

/** Почему метаданных нет. null в самих фактах не различает эти случаи. */
export type ProbeResult =
  | { ok: true; facts: VideoFacts }
  | { ok: false; reason: 'ffprobe-missing' | 'probe-failed'; detail: string };

let ffprobeMissing = false;

/** Разбор дроби вида «24/1» из поля r_frame_rate. */
function parseFps(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [num, den] = value.split('/').map((part) => Number.parseFloat(part));
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Прочитать метаданные видео.
 *
 * absolutePath берётся из MediaFacts, то есть уже прошёл проверку границ
 * MediaStore. Собственных путей этот модуль не строит.
 */
export async function probeVideo(absolutePath: string): Promise<ProbeResult> {
  if (ffprobeMissing) {
    return { ok: false, reason: 'ffprobe-missing', detail: 'ffprobe не найден в PATH' };
  }

  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,codec_name,r_frame_rate:format=duration',
        '-of', 'json',
        absolutePath
      ],
      { maxBuffer: 1024 * 1024 }
    );

    const payload = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number; codec_name?: string; r_frame_rate?: string }[];
      format?: { duration?: string };
    };

    const stream = payload.streams?.[0];
    const durationSeconds = Number.parseFloat(payload.format?.duration ?? '');

    return {
      ok: true,
      facts: {
        width: typeof stream?.width === 'number' ? stream.width : null,
        height: typeof stream?.height === 'number' ? stream.height : null,
        durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
        codec: typeof stream?.codec_name === 'string' ? stream.codec_name : null,
        fps: parseFps(stream?.r_frame_rate)
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      // Запоминаем один раз: незачем дёргать отсутствующую программу 23 раза.
      ffprobeMissing = true;
      return { ok: false, reason: 'ffprobe-missing', detail: 'ffprobe не найден в PATH' };
    }
    return { ok: false, reason: 'probe-failed', detail: message };
  }
}
