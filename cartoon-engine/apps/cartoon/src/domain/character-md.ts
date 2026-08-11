/**
 * Разбор паспорта персонажа.
 *
 * Markdown остаётся источником канона — база хранит его производную. Поэтому
 * здесь берётся только то, что движку действительно нужно: строка промпта,
 * якоря, рост, частота. Разделы «Функция», «Опознавательные знаки» и заметки о
 * перерендере в базу не едут: они написаны для человека, и копировать их
 * означало бы завести вторую, неизбежно устаревающую копию канона.
 *
 * Все десять паспортов проверены и структурно однородны, поэтому разбор
 * строгий: отсутствие любого обязательного поля — отказ с указанием файла, а
 * не молчаливый null. Паспорт, который не читается, надо чинить, а не
 * терпеть.
 */
import { InvariantError } from '@core/index';

export type CharacterPassport = {
  slug: string;
  number: number;
  name: string;
  nameRu: string;
  title: string;
  promptLine: string;
  colorAnchors: string[];
  heightRatio: number;
  frequency: CharacterFrequency;
  sourcePath: string;
  sourceSha256: string;
};

/** Частота появления в кадре. Значения взяты из паспортов, а не придуманы. */
export const FREQUENCIES = ['постоянный', 'второстепенный', 'редкий'] as const;
export type CharacterFrequency = (typeof FREQUENCIES)[number];

function must(
  value: RegExpMatchArray | null,
  sourcePath: string,
  what: string
): RegExpMatchArray {
  if (!value) {
    throw new InvariantError(
      `В паспорте ${sourcePath} не найдено: ${what}. Разбор остановлен — ` +
        'паспорт с нечитаемой структурой чинится, а не додумывается.'
    );
  }
  return value;
}

export function parseCharacterPassport(input: {
  markdown: string;
  slug: string;
  sourcePath: string;
  sourceSha256: string;
}): CharacterPassport {
  const { markdown, slug, sourcePath, sourceSha256 } = input;

  // '# 01 · Mossy / Москин' — номер, латинское имя, русское имя.
  const heading = must(
    markdown.match(/^#\s+(\d{1,2})\s*·\s*(.+?)\s*\/\s*(.+?)\s*$/m),
    sourcePath,
    'заголовок вида «# 01 · Mossy / Москин»'
  );
  const number = Number.parseInt(heading[1] as string, 10);
  const name = heading[2] as string;
  const nameRu = heading[3] as string;

  const title = must(
    markdown.match(/^\*\*Должность:\*\*\s*(.+?)\s*$/m),
    sourcePath,
    'строка «**Должность:** …»'
  )[1] as string;

  // Строка промпта — первая цитата в файле. Берётся ДОСЛОВНО: в самом паспорте
  // написано «копировать дословно», и любая нормализация увела бы генерацию от
  // эталона.
  const promptLine = must(
    markdown.match(/^>\s*(.+?)\s*$/m),
    sourcePath,
    'строка для промпта (цитата после «## Строка для промпта»)'
  )[1] as string;

  const anchorRow = must(
    markdown.match(/^\|\s*Цвет-якорь\s*\|(.+)$/m),
    sourcePath,
    'строка таблицы «| Цвет-якорь | … |»'
  )[1] as string;
  const colorAnchors = [...anchorRow.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) =>
    (m[0] as string).toUpperCase()
  );
  if (colorAnchors.length === 0) {
    throw new InvariantError(
      `В паспорте ${sourcePath} строка «Цвет-якорь» есть, но HEX-кода в ней нет.`
    );
  }

  const heightRatio = Number.parseFloat(
    must(
      markdown.match(/^\|\s*Рост\s*\|[^|]*?\*\*([\d.]+)\*\*/m),
      sourcePath,
      'строка таблицы «| Рост | **N.N** … |»'
    )[1] as string
  );
  if (!Number.isFinite(heightRatio) || heightRatio <= 0) {
    throw new InvariantError(`В паспорте ${sourcePath} нечитаемый рост.`);
  }

  // Частота — первое слово ячейки: дальше идёт пояснение через запятую или
  // точку («редкий. Финал сезона», «постоянный, каждое видео»).
  const frequencyRaw = (
    must(
      markdown.match(/^\|\s*Частота\s*\|\s*([^,.|]+)/m),
      sourcePath,
      'строка таблицы «| Частота | … |»'
    )[1] as string
  )
    .trim()
    .toLowerCase();

  if (!(FREQUENCIES as readonly string[]).includes(frequencyRaw)) {
    throw new InvariantError(
      `В паспорте ${sourcePath} незнакомая частота «${frequencyRaw}». ` +
        `Известные: ${FREQUENCIES.join(', ')}.`
    );
  }

  // Паспорт должен лежать в своём каталоге. Проверка ловит перепутанные папки:
  // '01-mossy' обязан начинаться с номера и заканчиваться латинским именем.
  const expectedSlug = `${String(number).padStart(2, '0')}-${name.toLowerCase()}`;
  if (slug !== expectedSlug) {
    throw new InvariantError(
      `Паспорт ${sourcePath} описывает «${number} · ${name}», что даёт каталог ` +
        `${expectedSlug}, а лежит он в ${slug}.`
    );
  }

  return {
    slug,
    number,
    name,
    nameRu,
    title,
    promptLine,
    colorAnchors,
    heightRatio,
    frequency: frequencyRaw as CharacterFrequency,
    sourcePath,
    sourceSha256
  };
}
