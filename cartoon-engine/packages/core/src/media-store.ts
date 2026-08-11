/**
 * Физический слой: единственное место в системе, знающее, где лежат байты.
 *
 * MediaStore не перемещает, не копирует и не изменяет файлы — он только
 * смотрит. Все операции над медиа идут через него, а не через абсолютные пути,
 * и причина не в аккуратности: 555 МБ эталонов и клипов уже лежат в структуре
 * папок, сложившейся до появления движка, и эта структура должна остаться
 * ровно такой, какая есть. Корень задаётся снаружи, поэтому его переезд
 * означает правку одной переменной окружения, а не переписывание базы.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MediaContentError,
  MediaNotFoundError,
  MediaPathError,
  NotConfiguredError
} from './errors';

/**
 * Грубый вид файла. По нему на следующих фазах выбираются проверки качества:
 * силуэт и цвет-якорь применимы к картинке и бессмысленны для звука.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'project';

export type MediaFacts = {
  /** Путь от MEDIA_ROOT, через прямой слэш. Именно он попадёт в базу. */
  relativePath: string;
  /** Абсолютный путь. За пределы MediaStore не уходит — только для диагностики. */
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  type: MediaKind;
};

// --- опознание по содержимому ------------------------------------------------
//
// Тип определяется по первым байтам, а не по расширению. Расширение — это
// утверждение файловой системы, и оно бывает ложным: переименованный JPEG с
// расширением .png прошёл бы любую проверку по имени и осел бы в базе как PNG.
// Раз уж файл всё равно читается целиком ради sha256, опознание достаётся
// почти бесплатно.

/** Сколько первых байт нужно самой длинной из известных сигнатур. */
const HEADER_BYTES = 16;

type Signature = {
  mimeType: string;
  kind: MediaKind;
  /** Расширения, при которых эта сигнатура не считается противоречием. */
  extensions: readonly string[];
  matches(header: Buffer): boolean;
};

function startsWith(header: Buffer, bytes: readonly number[]): boolean {
  if (header.length < bytes.length) return false;
  return bytes.every((byte, index) => header[index] === byte);
}

function ascii(header: Buffer, offset: number, length: number): string {
  if (header.length < offset + length) return '';
  return header.subarray(offset, offset + length).toString('latin1');
}

const SIGNATURES: readonly Signature[] = [
  {
    mimeType: 'image/png',
    kind: 'image',
    extensions: ['.png'],
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  },
  {
    mimeType: 'image/jpeg',
    kind: 'image',
    extensions: ['.jpg', '.jpeg'],
    matches: (h) => startsWith(h, [0xff, 0xd8, 0xff])
  },
  {
    mimeType: 'image/gif',
    kind: 'image',
    extensions: ['.gif'],
    matches: (h) => ascii(h, 0, 6) === 'GIF87a' || ascii(h, 0, 6) === 'GIF89a'
  },
  {
    mimeType: 'image/webp',
    kind: 'image',
    extensions: ['.webp'],
    matches: (h) => ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WEBP'
  },
  {
    mimeType: 'image/tiff',
    kind: 'image',
    extensions: ['.tif', '.tiff'],
    // 49 49 2A 00 (little-endian) и 4D 4D 00 2A (big-endian). Байтами, а не
    // строкой: в сигнатуре есть 0x00, и сравнение строк на нём легко соврать.
    matches: (h) =>
      startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a])
  },
  {
    // Многослойный документ, а не плоская картинка: вид project, потому что
    // проверки, осмысленные для растра, к нему неприменимы.
    mimeType: 'image/vnd.adobe.photoshop',
    kind: 'project',
    extensions: ['.psd', '.psb'],
    matches: (h) => ascii(h, 0, 4) === '8BPS'
  },
  {
    mimeType: 'audio/wav',
    kind: 'audio',
    extensions: ['.wav'],
    matches: (h) => ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WAVE'
  },
  {
    mimeType: 'video/x-matroska',
    kind: 'video',
    extensions: ['.mkv', '.webm'],
    matches: (h) => startsWith(h, [0x1a, 0x45, 0xdf, 0xa3])
  },
  {
    // ISOBMFF: и MP4, и MOV. Различаются брендом на смещении 8, поэтому
    // сигнатура одна, а mimeType уточняется отдельно.
    mimeType: 'video/mp4',
    kind: 'video',
    extensions: ['.mp4', '.mov', '.m4v'],
    matches: (h) => ascii(h, 4, 4) === 'ftyp'
  }
];

/** Первые байты в читаемом виде — попадают в текст ошибки, не в базу. */
export function describeHeader(header: Buffer): string {
  const hex = header.subarray(0, 8).toString('hex').replace(/(..)/g, '$1 ').trim();
  const printable = header
    .subarray(0, 8)
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '.');
  return `${hex} ("${printable}")`;
}

export type SniffResult = { mimeType: string; type: MediaKind };

/**
 * Опознание по сигнатуре и сверка с расширением.
 *
 * Неизвестная сигнатура — это отказ, а не «unknown». Зарегистрировать файл,
 * тип которого мы не смогли подтвердить, значит записать в графу mimeType
 * догадку и выдать её за факт. Новый формат добавляется тремя строками в
 * SIGNATURES — это дешевле, чем потом разбираться, откуда в базе взялась ложь.
 */
export function sniff(header: Buffer, fileName: string): SniffResult {
  const extension = path.extname(fileName).toLowerCase();
  const signature = SIGNATURES.find((candidate) => candidate.matches(header));

  if (!signature) {
    throw new MediaContentError(
      `Не удалось опознать тип файла ${fileName} по содержимому. ` +
        `Первые байты: ${describeHeader(header)}. ` +
        'Если формат нужен, добавьте его сигнатуру в media-store.ts.'
    );
  }

  if (!signature.extensions.includes(extension)) {
    throw new MediaContentError(
      `Файл ${fileName} по содержимому — ${signature.mimeType}, а расширение ` +
        `${extension || '(отсутствует)'} обещает другое. Расширение здесь не ` +
        'опечатка, а расхождение: регистрировать такой файл нельзя, пока не ' +
        'станет ясно, что из двух верно.'
    );
  }

  // Бренд ISOBMFF уточняет, MP4 это или QuickTime. Всё остальное однозначно.
  if (signature.mimeType === 'video/mp4' && ascii(header, 8, 4).startsWith('qt')) {
    return { mimeType: 'video/quicktime', type: signature.kind };
  }

  return { mimeType: signature.mimeType, type: signature.kind };
}

// --- пути --------------------------------------------------------------------

/** Каталоги, в которые обход не заходит: там нет медиа и очень много файлов. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Сравнение путей с учётом того, что Windows не различает регистр. */
function samePathRoot(child: string, root: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const normalizedChild = normalize(child);
  const normalizedRoot = normalize(root);
  return (
    normalizedChild === normalizedRoot ||
    normalizedChild.startsWith(normalizedRoot + path.sep)
  );
}

export class MediaStore {
  /** Корень после realpath. Считается один раз и переиспользуется. */
  private resolvedRoot: string | null = null;

  constructor(private readonly root: string) {
    if (!root || root.trim().length === 0) {
      throw new NotConfiguredError('MediaStore создан без корня медиа.');
    }
    if (!path.isAbsolute(root)) {
      throw new NotConfiguredError(
        `Корень медиа должен быть абсолютным путём, получено: ${root}`
      );
    }
  }

  /**
   * Корень из окружения.
   *
   * Значения по умолчанию нет намеренно. Неверный корень не сломает импорт —
   * он молча зарегистрирует не то дерево, и обнаружится это гораздо позже.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MediaStore {
    const root = env['MEDIA_ROOT']?.trim();
    if (!root) {
      throw new NotConfiguredError(
        'MEDIA_ROOT не задан. Добавьте строку MEDIA_ROOT=… в .env ' +
          '(файл в .gitignore) — образец лежит в .env.example.'
      );
    }
    return new MediaStore(path.resolve(root));
  }

  get rootPath(): string {
    return this.root;
  }

  /**
   * Относительный путь → абсолютный, с проверкой границы.
   *
   * Проверок две, и они ловят разное: логическая отсекает `..` и абсолютные
   * пути, а сверка realpath в describe() — символические ссылки, которые
   * логически лежат внутри корня, а физически указывают наружу.
   */
  resolve(relativePath: string): string {
    const raw = relativePath.trim();

    if (raw.length === 0) {
      throw new MediaPathError('Пустой путь.');
    }
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
      throw new MediaPathError(
        `Ожидался путь относительно корня медиа, получен абсолютный: ${raw}`
      );
    }

    const absolute = path.resolve(this.root, raw);
    const back = path.relative(this.root, absolute);

    if (back.startsWith('..') || path.isAbsolute(back)) {
      throw new MediaPathError(
        `Путь ${raw} выводит за пределы корня медиа (${this.root}).`
      );
    }

    return absolute;
  }

  /** Абсолютный путь → относительный в POSIX-виде. */
  toRelative(absolutePath: string): string {
    const back = path.relative(this.root, absolutePath);
    if (back.startsWith('..') || path.isAbsolute(back)) {
      throw new MediaPathError(
        `Путь ${absolutePath} лежит вне корня медиа (${this.root}).`
      );
    }
    return toPosix(back);
  }

  private async rootRealPath(): Promise<string> {
    if (this.resolvedRoot === null) {
      try {
        this.resolvedRoot = await realpath(this.root);
      } catch {
        throw new NotConfiguredError(
          `Корень медиа не существует или недоступен: ${this.root}`
        );
      }
    }
    return this.resolvedRoot;
  }

  /**
   * Факты о файле: размер, отпечаток, тип. Файл только читается.
   *
   * Чтение однопроходное: заголовок берётся из первого куска того же потока,
   * которым считается sha256. Дело не в скорости — второе открытие файла дало
   * бы окно, в котором заголовок и содержимое могут оказаться из разных версий
   * файла.
   */
  async describe(relativePath: string): Promise<MediaFacts> {
    const absolutePath = this.resolve(relativePath);

    const stats = await stat(absolutePath).catch(() => null);
    if (!stats) {
      throw new MediaNotFoundError(
        `Файла нет: ${toPosix(relativePath)} (искали в ${absolutePath}).`
      );
    }
    if (!stats.isFile()) {
      throw new MediaNotFoundError(
        `${toPosix(relativePath)} — не файл (каталог или ссылка на устройство).`
      );
    }

    // Символическая ссылка может логически лежать внутри корня, а указывать
    // наружу. Логическая проверка в resolve() этого не видит.
    const real = await realpath(absolutePath);
    if (!samePathRoot(real, await this.rootRealPath())) {
      throw new MediaPathError(
        `${toPosix(relativePath)} — ссылка, ведущая за пределы корня медиа.`
      );
    }

    const hash = createHash('sha256');
    let counted = 0;
    let header = Buffer.alloc(0);

    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = chunk as Buffer;
      if (header.length < HEADER_BYTES) {
        header = Buffer.concat([
          header,
          buffer.subarray(0, HEADER_BYTES - header.length)
        ]);
      }
      hash.update(buffer);
      counted += buffer.length;
    }

    // Размер, сообщённый файловой системой, и размер, реально прочитанный,
    // должны совпасть. Расхождение означает, что файл меняли прямо во время
    // чтения, и посчитанный отпечаток не описывает ни старую версию, ни новую.
    if (counted !== stats.size) {
      throw new MediaContentError(
        `Файл ${toPosix(relativePath)} менялся во время чтения: файловая ` +
          `система сообщила ${stats.size} байт, прочитано ${counted}. ` +
          'Отпечаток такого чтения недостоверен, импорт отменён.'
      );
    }

    const { mimeType, type } = sniff(header, path.basename(absolutePath));

    return {
      relativePath: this.toRelative(absolutePath),
      absolutePath,
      sizeBytes: counted,
      sha256: hash.digest('hex'),
      mimeType,
      type
    };
  }

  /** Есть ли файл. Ошибку не бросает: отсутствие — это ответ, а не сбой. */
  async exists(relativePath: string): Promise<boolean> {
    const absolutePath = this.resolve(relativePath);
    const stats = await stat(absolutePath).catch(() => null);
    return stats !== null && stats.isFile();
  }

  /**
   * Относительные пути всех файлов с указанным именем внутри поддерева.
   *
   * Нужно, чтобы вызывающий не ходил по файловой системе сам: правило «никаких
   * абсолютных путей вне MediaStore» иначе нарушается на первом же обходе.
   * Полноценный glob не заводится — за ним пришлось бы тянуть зависимость
   * ради одного шаблона.
   */
  async find(fileName: string, withinRelativeDir = '.'): Promise<string[]> {
    const startAt = this.resolve(withinRelativeDir);
    const found: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile() && entry.name === fileName) {
          found.push(this.toRelative(full));
        }
      }
    };

    await walk(startAt);
    return found.sort();
  }
}
