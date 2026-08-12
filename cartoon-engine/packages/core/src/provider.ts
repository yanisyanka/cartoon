/**
 * Контракт провайдера.
 *
 * Универсального `run(anything)` здесь нет намеренно. Главная привычка проекта —
 * проверять результат на границе слоя, а проверить можно только типизированный
 * результат. Поэтому база общая, а глагол у каждой capability свой.
 *
 * Долгие провайдеры разбиты на submit → poll → fetch, и это не украшение: между
 * отправкой и результатом процесс может умереть, а запуск на той стороне —
 * остаться. Дескриптор запуска обязан пережить перезапуск, иначе о выполненной
 * работе никто не узнает.
 */

/** Что провайдер умеет делать. Пока ровно одно. */
export type Capability = 'image-edit';

/**
 * Готовность провайдера.
 *
 * Не булево: «не настроен», «сервер не отвечает» и «нет весов модели» требуют
 * от человека трёх разных действий, и различать их должен вызывающий, а не
 * текст сообщения.
 *
 * Проверка готовности НЕ выполняет работу провайдера: она смотрит конфигурацию,
 * стучится в служебные ручки и читает каталоги. Ни одного шага генерации.
 */
export type ConfigState =
  | 'ready'
  | 'missing-config'
  | 'unavailable'
  | 'model-missing'
  | 'workflow-invalid';

export type ConfigStatus = {
  state: ConfigState;
  /** Что именно не так и что с этим делать. Пусто только у ready. */
  detail: string;
  /** Подробности, снятые попутно: версии, устройства. Идут в отпечаток среды. */
  facts: Record<string, unknown> | null;
};

export function isReady(status: ConfigStatus): boolean {
  return status.state === 'ready';
}

/**
 * Расход.
 *
 * Три единицы раздельно, а не сведёнными к долларам: курс кредита меняется, а
 * решение «хватит ли 546 кредитов на эпизод» принимается в кредитах.
 *
 * usd = 0 у локального провайдера — это ЗНАНИЕ, а не незнание: мы точно знаем,
 * что долларов не потрачено. Незнание записывается как null, и путать эти два
 * состояния нельзя.
 */
export type Spend = {
  usd: number | null;
  credits: number | null;
  tokens: number | null;
  /** false — биллинг ещё не досчитан и сумме верить нельзя. */
  settled: boolean;
  /** По чему сверять расход у провайдера: runId, requestId. */
  sourceRef: string | null;
};

/**
 * Нагрузка.
 *
 * Отдельно от Spend, потому что измеряет другой ресурс. У локальной генерации
 * доллары нулевые, но видеокарта в проекте одна, и очередь на ней — настоящее
 * ограничение. Планировщик, для которого локальный шаг бесплатен, поставит все
 * тридцать ракурсов в очередь и заблокирует GPU.
 */
export type Load = {
  gpuSeconds: number | null;
  wallClockMs: number | null;
  queueDepth: number | null;
};

export type Estimate = {
  spend: Spend;
  load: Load;
  /** Из чего сложилась оценка. Читается человеком. */
  basis: string;
};

/** Локальный расход: доллары точно нулевые, кредиты и токены не применимы. */
export function freeLocalSpend(sourceRef: string | null = null): Spend {
  return { usd: 0, credits: null, tokens: null, settled: true, sourceRef };
}

/**
 * Дескриптор запуска на стороне провайдера.
 *
 * Переживает перезапуск процесса: по нему запуск находится в очереди и в
 * истории ComfyUI, даже если наш процесс умер сразу после отправки.
 */
export type ProviderRun = {
  /** Идентификатор у провайдера. Он же попадёт в provenance. */
  ref: string;
  /** Когда отправили. */
  submittedAt: string;
};

export type RunState =
  | { state: 'pending'; queuePosition: number | null }
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; detail: string };

export type ProviderBase = {
  readonly id: string;
  readonly capability: Capability;
  readonly runtime: 'local' | 'api';
  /** Готовность. Работы не выполняет и денег не тратит. */
  configStatus(): Promise<ConfigStatus>;
};

/** Вход правки изображения. Референс приходит байтами, а не путём. */
export type ImageEditInput = {
  /** Исходное изображение: содержимое и имя для стороны провайдера. */
  reference: { fileName: string; bytes: Buffer };
  prompt: string;
  /** Фиксируется вызывающим и записывается в provenance. */
  seed: string;
  /** Ключ записи в реестре моделей. */
  modelKey: string;
  /** Прочие параметры запуска: шаги, cfg и подобное. */
  parameters: Record<string, unknown>;
};

export type ImageEditOutput = {
  /** Байты результата. В MediaStore их кладёт вызывающий, не провайдер. */
  bytes: Buffer;
  /** Имя файла у провайдера — для диагностики, не для пути в реестре. */
  providerFileName: string;
  /** Отпечаток запущенного графа: по нему видно, тот ли workflow. */
  workflowHash: string;
  /** Сам граф текстом — ради восстановимости, а не только опознаваемости. */
  workflowJson: string;
  /** Состояние окружения на момент запуска. */
  envFingerprint: Record<string, unknown>;
  spend: Spend;
  load: Load;
};

export interface ImageEditProvider extends ProviderBase {
  readonly capability: 'image-edit';
  /** Оценка без обращения к сети. */
  estimate(input: ImageEditInput): Estimate;
  submit(input: ImageEditInput): Promise<ProviderRun>;
  poll(run: ProviderRun): Promise<RunState>;
  fetch(run: ProviderRun): Promise<ImageEditOutput>;
}

// --- ошибки -------------------------------------------------------------------

/** Провайдер не готов: конфигурация, сервер или веса. */
export class ProviderNotReadyError extends Error {
  constructor(
    message: string,
    readonly status: ConfigStatus
  ) {
    super(message);
    this.name = 'ProviderNotReadyError';
  }
}

/** Ответ провайдера получен, но не соответствует контракту. */
export class ProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

/**
 * Запуск не довёл работу до конца.
 *
 * Отделено от ProviderResponseError намеренно: там ответ есть, но кривой; здесь
 * ответа нет вовсе, а ресурсы уже потрачены. Для платного провайдера это
 * означало бы списанные деньги, для локального — занятую видеокарту, и в обоих
 * случаях человеку важен дескриптор запуска, а не текст исключения.
 */
export class ProviderRunFailedError extends Error {
  constructor(
    message: string,
    readonly runRef: string | null,
    readonly spendLikely: boolean
  ) {
    super(message);
    this.name = 'ProviderRunFailedError';
  }
}
