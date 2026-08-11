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

test('config: относительный корень не принимается', () => {
  assert.throws(() => new MediaStore('./media'), NotConfiguredError);
});

test('config: пустой MEDIA_ROOT даёт понятный отказ', () => {
  assert.throws(() => MediaStore.fromEnv({}), NotConfiguredError);
  assert.throws(() => MediaStore.fromEnv({ MEDIA_ROOT: '   ' }), NotConfiguredError);
});
