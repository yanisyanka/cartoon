/**
 * Опознание персонажных ассетов по содержимому.
 *
 * Проверки синтетические: роль должна зависеть от измеренного кадра, а не от
 * имени файла, и убедиться в этом можно только подставив имя и содержимое
 * порознь. Что профили сходятся на настоящих 68 файлах, подтверждает
 * check:assets.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MediaFacts } from '../packages/core/src/media-store';
import { classifyCharacterAsset } from '../apps/cartoon/src/domain/character-assets';
import type { VideoFacts } from '../apps/cartoon/src/domain/video-probe';

const SLUGS = new Set(['01-mossy', '02-fungi']);

function facts(overrides: Partial<MediaFacts>): MediaFacts {
  return {
    relativePath: 'characters/01-mossy/ref_front.png',
    absolutePath: 'C:/media/characters/01-mossy/ref_front.png',
    sizeBytes: 26_459_071,
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    type: 'image',
    width: 3584,
    height: 4800,
    ...overrides
  };
}

const CLIP_VIDEO: VideoFacts = {
  width: 828,
  height: 1108,
  durationMs: 5040,
  codec: 'h264',
  fps: 24
};

// --- ref-front ---------------------------------------------------------------

test('ref-front: эталон нужного размера опознаётся', () => {
  const result = classifyCharacterAsset(
    'characters/01-mossy/ref_front.png',
    facts({}),
    null,
    SLUGS
  );

  assert.equal(result.role, 'ref-front');
  assert.equal(result.slug, '01-mossy');
});

test('ref-front: имя то, размер другой — роли нет', () => {
  // Ровно случай архивного «Твиглет.png»: 2134×3297 вместо 3584×4800.
  const result = classifyCharacterAsset(
    'characters/01-mossy/ref_front.png',
    facts({ width: 2134, height: 3297 }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
  assert.equal(result.slug, '01-mossy');
  if (result.role === null) assert.match(result.reason, /3584×4800/);
});

// --- card --------------------------------------------------------------------

test('card: карточка опознаётся по портретному кадру в диапазоне', () => {
  for (const [width, height] of [
    [190, 325],
    [165, 315],
    [224, 317],
    [170, 295]
  ]) {
    const result = classifyCharacterAsset(
      'characters/01-mossy/card.jpg',
      facts({
        relativePath: 'characters/01-mossy/card.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 21_772,
        width,
        height
      }),
      null,
      SLUGS
    );
    assert.equal(result.role, 'card', `${width}×${height}`);
  }
});

test('card: альбомная картинка карточкой не считается', () => {
  // «кто это.jpg» — 250×210: по ширине в диапазон попадает, по форме нет.
  const result = classifyCharacterAsset(
    'characters/01-mossy/card.jpg',
    facts({
      relativePath: 'characters/01-mossy/card.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 16_138,
      width: 250,
      height: 210
    }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
});

test('card: крупное фото карточкой не считается', () => {
  const result = classifyCharacterAsset(
    'characters/01-mossy/card.jpg',
    facts({
      relativePath: 'characters/01-mossy/card.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 121_481,
      width: 1147,
      height: 1280
    }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
});

// --- clip --------------------------------------------------------------------

test('clip: клип нужного формата и длительности опознаётся', () => {
  const result = classifyCharacterAsset(
    'characters/01-mossy/clip.mp4',
    facts({
      relativePath: 'characters/01-mossy/clip.mp4',
      mimeType: 'video/mp4',
      type: 'video',
      sizeBytes: 5_870_904,
      width: null,
      height: null
    }),
    CLIP_VIDEO,
    SLUGS
  );

  assert.equal(result.role, 'clip');
});

test('clip: другой кадр — роли нет', () => {
  // Архивный «Твиглет.mp4»: 772×1192 вместо 828×1108.
  const result = classifyCharacterAsset(
    'characters/01-mossy/clip.mp4',
    facts({
      relativePath: 'characters/01-mossy/clip.mp4',
      mimeType: 'video/mp4',
      type: 'video',
      width: null,
      height: null
    }),
    { ...CLIP_VIDEO, width: 772, height: 1192 },
    SLUGS
  );

  assert.equal(result.role, null);
});

test('clip: без метаданных видео роль не назначается', () => {
  // ffprobe недоступен — это «не смогли проверить», а не «проверили и хорошо».
  const result = classifyCharacterAsset(
    'characters/01-mossy/clip.mp4',
    facts({
      relativePath: 'characters/01-mossy/clip.mp4',
      mimeType: 'video/mp4',
      type: 'video',
      width: null,
      height: null
    }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
});

// --- привязка к персонажу ----------------------------------------------------

test('character: файл вне каталога персонажа персонажу не приписывается', () => {
  const result = classifyCharacterAsset(
    'characters/MOSS KIN-лесные духи/Твиглет.png',
    facts({ relativePath: 'characters/MOSS KIN-лесные духи/Твиглет.png' }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
  assert.equal(result.slug, null);
  if (result.role === null) assert.match(result.reason, /вне каталога персонажа/);
});

test('character: неизвестный slug персонажем не считается', () => {
  const result = classifyCharacterAsset(
    'characters/99-nobody/ref_front.png',
    facts({ relativePath: 'characters/99-nobody/ref_front.png' }),
    null,
    SLUGS
  );

  assert.equal(result.slug, null);
});

test('unknown: незнакомое имя роли не получает', () => {
  const result = classifyCharacterAsset(
    'characters/01-mossy/turnaround.png',
    facts({ relativePath: 'characters/01-mossy/turnaround.png' }),
    null,
    SLUGS
  );

  assert.equal(result.role, null);
  assert.equal(result.slug, '01-mossy');
  if (result.role === null) assert.match(result.reason, /turnaround\.png/);
});
