/**
 * Ошибки ядра. CLI и проверки переводят их в коды выхода и понятный текст.
 *
 * Типов ровно столько, сколько различает вызывающий. «Не настроено», «файла
 * нет» и «файл не тот, чем притворяется» требуют от человека трёх разных
 * действий — потому и разделены. Один общий Error заставил бы разбирать текст
 * сообщения, а это худший вид связанности.
 */

/** Конфигурация неполна: не задана переменная окружения или путь. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

/**
 * Путь недопустим: задан абсолютным или выводит за пределы MEDIA_ROOT.
 *
 * Отдельно от «файла нет» намеренно. Здесь файла может и не быть, но проблема
 * не в этом: такой путь нельзя даже проверять, потому что он выходит за
 * границу, которую MediaStore обязан держать.
 */
export class MediaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaPathError';
  }
}

/** Файла по указанному пути нет, либо это не файл. */
export class MediaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaNotFoundError';
  }
}

/**
 * Содержимое файла не соответствует тому, чем он себя объявляет.
 *
 * Два случая: расширение расходится с сигнатурой в первых байтах, и размер
 * после чтения не совпал с тем, что сообщила файловая система. Второе означает,
 * что файл меняли прямо во время чтения, и посчитанный отпечаток недостоверен.
 */
export class MediaContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaContentError';
  }
}

/**
 * Данные, которые собирались записать, противоречат сами себе.
 *
 * Бросается до обращения к базе: несогласованная строка не должна дожить до
 * записи, иначе противоречие придётся объяснять уже постфактум.
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}
