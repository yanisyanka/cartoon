/**
 * Разбор паспорта персонажа.
 *
 * Образец здесь синтетический и намеренно: проверка должна ловить поломку
 * парсера, а не изменения в реальном каноне. Что парсер справляется с десятью
 * настоящими паспортами, подтверждает check:canon — на живых файлах.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvariantError } from '../packages/core/src/errors';
import { parseCharacterPassport } from '../apps/cartoon/src/domain/character-md';

const SAMPLE = `# 01 · Mossy / Москин

**Должность:** Хранитель мха и тишины
**Статус:** главный герой канала.

## Строка для промпта (копировать дословно)

> mossy forest spirit, hooded cloak, **no mouth**, small mushroom pin

## Опознавательные знаки

- Три красных мухомора на макушке.

## Параметры

| | |
|---|---|
| Цвет-якорь | \`#4A5D3A\` мшисто-зелёный + \`#C43B2E\` только в трёх мухоморах |
| Рост | **1.0** — эталон, от него считаются остальные |
| Частота | постоянный, каждое видео |
| Ракурс-подпись | фронт, контровой луч |

## Функция

Хранитель тишины.
`;

function parse(markdown: string, slug = '01-mossy') {
  return parseCharacterPassport({
    markdown,
    slug,
    sourcePath: `characters/${slug}/character.md`,
    sourceSha256: 'a'.repeat(64)
  });
}

test('passport: разбирается полностью', () => {
  const passport = parse(SAMPLE);

  assert.equal(passport.number, 1);
  assert.equal(passport.name, 'Mossy');
  assert.equal(passport.nameRu, 'Москин');
  assert.equal(passport.title, 'Хранитель мха и тишины');
  assert.equal(passport.heightRatio, 1.0);
  assert.equal(passport.frequency, 'постоянный');
  assert.deepEqual(passport.colorAnchors, ['#4A5D3A', '#C43B2E']);
  assert.equal(passport.sourcePath, 'characters/01-mossy/character.md');
});

test('passport: строка промпта берётся дословно', () => {
  const passport = parse(SAMPLE);

  assert.equal(
    passport.promptLine,
    'mossy forest spirit, hooded cloak, **no mouth**, small mushroom pin'
  );
  // Markdown-разметка внутри строки НЕ вычищается: в промпт уходит ровно то,
  // что написано в паспорте.
  assert.ok(passport.promptLine.includes('**no mouth**'));
});

test('passport: частота отрезается по первому разделителю', () => {
  const withDot = SAMPLE.replace(
    '| Частота | постоянный, каждое видео |',
    '| Частота | редкий. Финал сезона, анонс заранее |'
  );
  assert.equal(parse(withDot).frequency, 'редкий');
});

test('passport: один якорь тоже допустим', () => {
  const single = SAMPLE.replace(
    '| Цвет-якорь | `#4A5D3A` мшисто-зелёный + `#C43B2E` только в трёх мухоморах |',
    '| Цвет-якорь | `#c43b2e` красный мухомора |'
  );
  assert.deepEqual(parse(single).colorAnchors, ['#C43B2E']);
});

test('passport: отсутствие обязательного поля — отказ с именем файла', () => {
  const noPrompt = SAMPLE.replace(
    '> mossy forest spirit, hooded cloak, **no mouth**, small mushroom pin',
    ''
  );

  assert.throws(
    () => parse(noPrompt),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.match(error.message, /characters\/01-mossy\/character\.md/);
      return true;
    }
  );
});

test('passport: нет должности — отказ', () => {
  assert.throws(
    () => parse(SAMPLE.replace('**Должность:** Хранитель мха и тишины', '')),
    InvariantError
  );
});

test('passport: нет якоря — отказ', () => {
  const noHex = SAMPLE.replace(
    '| Цвет-якорь | `#4A5D3A` мшисто-зелёный + `#C43B2E` только в трёх мухоморах |',
    '| Цвет-якорь | мшисто-зелёный |'
  );
  assert.throws(() => parse(noHex), InvariantError);
});

test('passport: незнакомая частота — отказ, а не тихое сохранение', () => {
  const odd = SAMPLE.replace(
    '| Частота | постоянный, каждое видео |',
    '| Частота | иногда, по настроению |'
  );
  assert.throws(() => parse(odd), InvariantError);
});

test('passport: паспорт в чужом каталоге — отказ', () => {
  assert.throws(
    () => parse(SAMPLE, '02-fungi'),
    (error: unknown) => {
      assert.ok(error instanceof InvariantError);
      assert.match(error.message, /01-mossy/);
      return true;
    }
  );
});
