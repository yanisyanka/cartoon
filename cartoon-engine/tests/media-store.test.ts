import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MediaStore } from '../packages/core/src/media-store';
import {
  MediaContentError,
  MediaNotFoundError,
  MediaPathError,
  NotConfiguredError
} from '../packages/core/src/errors';
import {
  createSandbox,
  JPEG_MINIMAL,
  PNG_1X1,
  PNG_1X1_BYTES,
  PNG_1X1_SHA256,
  type Sandbox
} from './fixtures';

let sandbox: Sandbox;
let store: MediaStore;

before(async () => {
  sandbox = await createSandbox();
  store = new MediaStore(sandbox.root);

  await sandbox.put('characters/01-mossy/ref_front.png', PNG_1X1);
  await sandbox.put('characters/02-fungi/ref_front.png', PNG_1X1);
  await sandbox.put('characters/01-mossy/card.jpg', JPEG_MINIMAL);
  // Файл лжёт о себе расширением: внутри JPEG, снаружи .png.
  await sandbox.put('characters/03-liar/ref_front.png', JPEG_MINIMAL);
  await sandbox.put('characters/04-empty/ref_front.png', Buffer.alloc(0));
});

after(async () => {
  await sandbox.dispose();
});

test('hash: известный файл даёт известный отпечаток', async () => {
  const facts = await store.describe('characters/01-mossy/ref_front.png');

  assert.equal(facts.sha256, PNG_1X1_SHA256);
  assert.equal(facts.sizeBytes, PNG_1X1_BYTES);
  assert.equal(facts.mimeType, 'image/png');
  assert.equal(facts.type, 'image');
});

test('hash: отпечаток устойчив между вызовами', async () => {
  const first = await store.describe('characters/01-mossy/ref_front.png');
  const second = await store.describe('characters/01-mossy/ref_front.png');

  assert.equal(first.sha256, second.sha256);
});

test('path: относительный путь всегда возвращается через прямой слэш', async () => {
  const facts = await store.describe('characters\\01-mossy\\ref_front.png');

  assert.equal(facts.relativePath, 'characters/01-mossy/ref_front.png');
  assert.ok(!facts.relativePath.includes('\\'));
});

test('missing: несуществующего файла — понятная ошибка', async () => {
  await assert.rejects(
    () => store.describe('characters/99-nobody/ref_front.png'),
    (error: unknown) => {
      assert.ok(error instanceof MediaNotFoundError);
      assert.match(error.message, /Файла нет/);
      return true;
    }
  );
});

test('missing: каталог — не файл', async () => {
  await assert.rejects(
    () => store.describe('characters/01-mossy'),
    MediaNotFoundError
  );
});

test('path: выход за корень отклоняется', async () => {
  await assert.rejects(() => store.describe('../secrets.png'), MediaPathError);
  await assert.rejects(
    () => store.describe('characters/../../secrets.png'),
    MediaPathError
  );
});

test('path: абсолютный путь отклоняется', async () => {
  await assert.rejects(() => store.describe('C:/Windows/system.ini'), MediaPathError);
  await assert.rejects(() => store.describe('/etc/passwd'), MediaPathError);
});

test('content: расхождение расширения и содержимого отклоняется', async () => {
  await assert.rejects(
    () => store.describe('characters/03-liar/ref_front.png'),
    (error: unknown) => {
      assert.ok(error instanceof MediaContentError);
      assert.match(error.message, /image\/jpeg/);
      return true;
    }
  );
});

test('content: неопознанный файл отклоняется, а не помечается unknown', async () => {
  await assert.rejects(
    () => store.describe('characters/04-empty/ref_front.png'),
    (error: unknown) => {
      assert.ok(error instanceof MediaContentError);
      assert.match(error.message, /Не удалось опознать/);
      return true;
    }
  );
});

test('find: обход возвращает относительные пути в устойчивом порядке', async () => {
  const found = await store.find('ref_front.png', 'characters');

  assert.deepEqual(found, [
    'characters/01-mossy/ref_front.png',
    'characters/02-fungi/ref_front.png',
    'characters/03-liar/ref_front.png',
    'characters/04-empty/ref_front.png'
  ]);
});

test('exists: отсутствие файла — ответ, а не исключение', async () => {
  assert.equal(await store.exists('characters/01-mossy/ref_front.png'), true);
  assert.equal(await store.exists('characters/99-nobody/ref_front.png'), false);
});

/**
 * Регистр пути канонизируется по диску.
 *
 * Проверка Windows-специфична, потому что специфична сама беда: файловая
 * система регистр не различает, а уникальный индекс SQLite — различает. Без
 * канонизации `CHARACTERS/01-MOSSY/ref_front.png` доехал бы до базы отдельной
 * строкой, и один физический файл получил бы две записи, обойдя всю проверку
 * версий. На Linux такого пути просто нет, и проверять там нечего.
 */
test(
  'path: регистр приводится к тому, как файл записан на диске',
  { skip: process.platform !== 'win32' },
  async () => {
    const canonical = await store.describe('characters/01-mossy/ref_front.png');
    const shouting = await store.describe('CHARACTERS/01-MOSSY/ref_front.png');
    const mixed = await store.describe('Characters/01-Mossy/ref_front.PNG');

    assert.equal(canonical.relativePath, 'characters/01-mossy/ref_front.png');
    assert.equal(shouting.relativePath, canonical.relativePath);
    assert.equal(mixed.relativePath, canonical.relativePath);
    assert.equal(shouting.sha256, canonical.sha256);
  }
);

test('readText: паспорт читается вместе с отпечатком', async () => {
  await sandbox.put('characters/01-mossy/character.md', Buffer.from('# 01 · Mossy\n', 'utf8'));

  const file = await store.readText('characters/01-mossy/character.md');

  assert.equal(file.relativePath, 'characters/01-mossy/character.md');
  assert.match(file.text, /^# 01 · Mossy/);
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(file.sizeBytes, Buffer.byteLength('# 01 · Mossy\n', 'utf8'));
});

test('readText: слишком крупный файл текстом не читается', async () => {
  await assert.rejects(
    () => store.readText('characters/01-mossy/ref_front.png', 10),
    MediaContentError
  );
});

test('readText: границы корня действуют и здесь', async () => {
  await assert.rejects(() => store.readText('../secrets.md'), MediaPathError);
});

test('config: относительный корень не принимается', () => {
  assert.throws(() => new MediaStore('./media'), NotConfiguredError);
});

test('config: пустой MEDIA_ROOT даёт понятный отказ', () => {
  assert.throws(() => MediaStore.fromEnv({}), NotConfiguredError);
  assert.throws(() => MediaStore.fromEnv({ MEDIA_ROOT: '   ' }), NotConfiguredError);
});
