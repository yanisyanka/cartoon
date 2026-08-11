/**
 * Происхождение: откуда взялись байты и можно ли получить их снова.
 *
 * Модуль намеренно не знает ни про базу, ни про файловую систему — здесь только
 * правило, по которому происхождение назначается. Правило одно и оно
 * несимметрично: систему легко заставить соврать в сторону «воспроизводимо»
 * (достаточно поверить производителю на слово) и почти невозможно — в сторону
 * «неизвестно». Поэтому все сомнительные случаи падают в unknown.
 */
import { InvariantError } from './errors';

/** Кто произвёл байты. */
export type ProducedBy =
  /** Файл существовал до движка. Как он сделан — снаружи неизвестно. */
  | 'import'
  /** Файл создан провайдером через движок: модель, параметры и seed записаны. */
  | 'provider'
  /** Файл создан или изменён человеком в Photoshop, After Effects, Premiere. */
  | 'human';

/** Можно ли получить эти же байты снова. */
export type Reproducibility =
  /** Не знаем. Единственно честное значение для всего, что пришло извне. */
  | 'unknown'
  /** Локальная модель, стабильный seed, зафиксированное окружение, без рук. */
  | 'deterministic'
  /** Провайдер отработал, но повтор даст другой результат. */
  | 'stochastic'
  /** В цепочке есть ручной шаг — повторить нельзя в принципе. */
  | 'human-touched';

export const PRODUCED_BY: readonly ProducedBy[] = ['import', 'provider', 'human'];

export const REPRODUCIBILITY: readonly Reproducibility[] = [
  'unknown',
  'deterministic',
  'stochastic',
  'human-touched'
];

export type ProvenanceDraft = {
  producedBy: ProducedBy;
  reproducibility: Reproducibility;
  /** Почему происхождение именно такое. Читается человеком, не машиной. */
  note: string | null;
};

/**
 * Происхождение файла, существовавшего до движка.
 *
 * Ровно `unknown`, и никаких вариантов. Про десять эталонов персонажей мы не
 * знаем ни модели, ни seed, ни версии ComfyUI, ни параметров запроса — файлы
 * появились раньше, чем система, которая умеет это записывать. Поставить им
 * что-либо кроме unknown значило бы придумать факт, а не зафиксировать его.
 *
 * Это та же честность, что и `basis: metadata_only` в соседнем проекте: система
 * обязана показывать границу собственного знания, а не заполнять её догадкой.
 */
export function importedProvenance(note?: string): ProvenanceDraft {
  return {
    producedBy: 'import',
    reproducibility: 'unknown',
    note:
      note ??
      'Файл существовал до движка. Модель, seed, workflow, версия ComfyUI и ' +
        'параметры запроса неизвестны и восстановлению не подлежат.'
  };
}

/**
 * Проверка происхождения перед записью.
 *
 * Ловит не опечатки, а противоречия: происхождение — это утверждение о мире, и
 * несогласованное утверждение хуже отсутствующего. Импортированный файл,
 * помеченный воспроизводимым, тихо сломал бы всю ценность реестра.
 */
export function assertValidProvenance(draft: ProvenanceDraft): void {
  if (!PRODUCED_BY.includes(draft.producedBy)) {
    throw new InvariantError(`Неизвестное значение producedBy: ${draft.producedBy}.`);
  }

  if (!REPRODUCIBILITY.includes(draft.reproducibility)) {
    throw new InvariantError(
      `Неизвестное значение reproducibility: ${draft.reproducibility}.`
    );
  }

  if (draft.producedBy === 'import' && draft.reproducibility !== 'unknown') {
    throw new InvariantError(
      `Импортированный файл не может быть ${draft.reproducibility}: о его ` +
        'создании ничего не известно, и объявить его воспроизводимым нельзя.'
    );
  }

  if (draft.producedBy === 'human' && draft.reproducibility !== 'human-touched') {
    throw new InvariantError(
      'Файл, сделанный руками, воспроизводим быть не может — ожидалось ' +
        `human-touched, получено ${draft.reproducibility}.`
    );
  }
}
