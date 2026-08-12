/**
 * Фикстуры для проверок.
 *
 * Файлы создаются во временном каталоге системы, а не внутри проекта:
 * MEDIA_ROOT указывает на настоящее дерево мультфильма, и писать туда даже
 * временный мусор нельзя — там 555 МБ материала, который ничем не защищён.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Настоящий PNG 1×1, 70 байт. Именно настоящий, а не «первые байты похожи»:
 * MediaStore опознаёт файлы по сигнатуре, и подделка проверяла бы не то.
 */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Отпечаток PNG_1X1. Константа, а не вычисление: смысл проверки в стабильности. */
export const PNG_1X1_SHA256 =
  'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';

export const PNG_1X1_BYTES = 70;

/** Минимальный валидный JPEG — нужен, чтобы проверить сверку с расширением. */
export const JPEG_MINIMAL = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

export type Sandbox = {
  root: string;
  /** Записать файл по пути относительно корня песочницы. */
  put(relativePath: string, bytes: Buffer): Promise<string>;
  /** Убрать файл или каталог песочницы. Только внутри неё. */
  remove(relativePath: string): Promise<void>;
  dispose(): Promise<void>;
};

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cartoon-engine-'));

  return {
    root,
    async put(relativePath, bytes) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      return absolute;
    },
    async remove(relativePath) {
      // Только внутри песочницы: путь собирается от её корня, наружу выйти
      // нечем. Настоящее дерево проекта этим кодом не достижимо.
      await rm(path.join(root, relativePath), { recursive: true, force: true });
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    }
  };
}
