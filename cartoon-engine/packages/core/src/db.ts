/**
 * Подключение к базе движка.
 *
 * Фабрика принимает URL параметром, а не читает окружение внутри: проверкам
 * нужен временный файл базы, и без этого они были бы вынуждены работать с
 * рабочими данными. Синглтон поверх фабрики — для CLI, где база одна.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';
import { NotConfiguredError } from './errors';

export type EngineDb = PrismaClient;

export function createEngineDb(url: string): EngineDb {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

let cached: EngineDb | null = null;

/**
 * База из окружения.
 *
 * Значения по умолчанию нет намеренно, хотя соблазн велик. Молчаливый
 * `file:./engine.db` при запуске из чужого каталога создал бы вторую пустую
 * базу — и человек искал бы пропавшие ассеты, вместо того чтобы прочитать одну
 * понятную строку отказа.
 */
export function getEngineDb(env: NodeJS.ProcessEnv = process.env): EngineDb {
  if (cached) return cached;

  const url = env['DATABASE_URL']?.trim();
  if (!url) {
    throw new NotConfiguredError(
      'DATABASE_URL не задан. Добавьте строку DATABASE_URL=… в .env ' +
        '(файл в .gitignore) — образец лежит в .env.example.'
    );
  }

  cached = createEngineDb(url);
  return cached;
}

/** Для проверок и офлайн-запусков. */
export function setEngineDb(db: EngineDb | null): void {
  cached = db;
}
