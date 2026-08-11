/**
 * Доменные типы ассета.
 *
 * Ни Prisma, ни файловой системы: только то, чем ассет является для остальной
 * системы. Строку в базе описывает репозиторий, физический файл — MediaStore.
 */
import type { MediaKind } from './media-store';
import type { ProducedBy, Reproducibility } from './provenance';

/** Ассет в том виде, в каком его отдают CLI и проверки. */
export type AssetView = {
  id: string;
  relativePath: string;
  type: MediaKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  provenance: {
    producedBy: ProducedBy;
    reproducibility: Reproducibility;
    note: string | null;
  } | null;
};

/**
 * Чем закончилась попытка зарегистрировать файл.
 *
 * Четыре исхода вместо булева «получилось / нет», потому что человеку они
 * говорят разное и требуют разных действий.
 *
 *   registered          файл увиден впервые;
 *   already-registered  тот же путь, те же байты — норма при повторном запуске;
 *   content-conflict    те же байты по НОВОМУ пути: в дереве завёлся дубликат;
 *   content-changed     тот же путь, ДРУГИЕ байты: файл переделали на диске.
 *
 * Последние два — не ошибки файловой системы, а факты о проекте, и молчать о
 * них нельзя. content-changed особенно: ассет versioning появится только с
 * полем supersedes на следующей фазе, а до тех пор единственный честный ответ —
 * отказаться и сказать, что именно разошлось.
 */
export type ImportOutcome =
  | { status: 'registered'; asset: AssetView }
  | { status: 'already-registered'; asset: AssetView }
  | {
      status: 'content-conflict';
      /** Ассет, под которым эти байты уже зарегистрированы. */
      asset: AssetView;
      /** Путь, по которому те же байты встретились сейчас. */
      requestedPath: string;
    }
  | {
      status: 'content-changed';
      /** Ассет, записанный по этому пути раньше. */
      asset: AssetView;
      /** Отпечаток, который лежит по этому пути сейчас. */
      currentSha256: string;
    };

/** Зарегистрирован ли файл в результате этого вызова. */
export function isNewlyRegistered(outcome: ImportOutcome): boolean {
  return outcome.status === 'registered';
}
