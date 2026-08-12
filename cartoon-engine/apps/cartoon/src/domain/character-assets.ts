/**
 * Опознание персонажных ассетов по содержимому.
 *
 * Имя файла здесь только выдвигает гипотезу; принимает её или отвергает
 * измеренный кадр. Разница не теоретическая: в архиве лежат `Твиглет.png`
 * 2134×3297 и `Твиглет.mp4` 772×1192, которые по имени неотличимы от эталона
 * и клипа, а по содержимому — прежние версии другого формата.
 *
 * Пороги выведены из фактического замера всех 68 файлов, а не из документации.
 * CAST.md называет карточку «190×325», и это верно ровно для одного Москина:
 * на деле карточки идут от 165×295 до 224×325. Профиль описывает то, что есть.
 */
import type { MediaFacts } from '@core/index';
import type { VideoFacts } from './video-probe';
import type { AssetRole } from './roles';

export type AssetProfile = {
  role: AssetRole;
  /** Имя файла, которое выдвигает гипотезу о роли. */
  fileName: string;
  /** Чем гипотеза подтверждается. Текст идёт в отчёт при несовпадении. */
  expected: string;
  matches(facts: MediaFacts, video: VideoFacts | null): boolean;
};

/** Замеры эталонов: все десять ровно 3584×4800. */
const REFERENCE_WIDTH = 3584;
const REFERENCE_HEIGHT = 4800;

/** Замеры карточек: 165…224 по ширине, 295…325 по высоте, все — портрет. */
const CARD_MIN_WIDTH = 150;
const CARD_MAX_WIDTH = 250;
const CARD_MIN_HEIGHT = 280;
const CARD_MAX_HEIGHT = 340;
const CARD_MAX_BYTES = 100_000;

/** Замеры клипов: все десять ровно 828×1108 и 5,04 с. */
const CLIP_WIDTH = 828;
const CLIP_HEIGHT = 1108;
const CLIP_MIN_MS = 4_500;
const CLIP_MAX_MS = 5_500;

export const ASSET_PROFILES: readonly AssetProfile[] = [
  {
    role: 'ref-front',
    fileName: 'ref_front.png',
    expected: `PNG ровно ${REFERENCE_WIDTH}×${REFERENCE_HEIGHT}`,
    matches: (facts) =>
      facts.mimeType === 'image/png' &&
      facts.width === REFERENCE_WIDTH &&
      facts.height === REFERENCE_HEIGHT
  },
  {
    role: 'card',
    fileName: 'card.jpg',
    expected:
      `JPEG-портрет ${CARD_MIN_WIDTH}…${CARD_MAX_WIDTH} × ` +
      `${CARD_MIN_HEIGHT}…${CARD_MAX_HEIGHT}, до ${CARD_MAX_BYTES} байт`,
    matches: (facts) => {
      if (facts.mimeType !== 'image/jpeg') return false;
      if (facts.width === null || facts.height === null) return false;
      // Портретность проверяется отдельно от диапазонов: она отсекает
      // «кто это.jpg» 250×210, который по ширине в диапазон попадает.
      if (facts.height <= facts.width) return false;
      return (
        facts.width >= CARD_MIN_WIDTH &&
        facts.width <= CARD_MAX_WIDTH &&
        facts.height >= CARD_MIN_HEIGHT &&
        facts.height <= CARD_MAX_HEIGHT &&
        facts.sizeBytes <= CARD_MAX_BYTES
      );
    }
  },
  {
    role: 'clip',
    fileName: 'clip.mp4',
    expected: `MP4 ровно ${CLIP_WIDTH}×${CLIP_HEIGHT}, длительность около 5 с`,
    matches: (facts, video) => {
      if (facts.type !== 'video') return false;
      if (!video || video.width === null || video.height === null) return false;
      if (video.width !== CLIP_WIDTH || video.height !== CLIP_HEIGHT) return false;
      if (video.durationMs === null) return false;
      return video.durationMs >= CLIP_MIN_MS && video.durationMs <= CLIP_MAX_MS;
    }
  }
];

export type Classification =
  | { role: AssetRole; slug: string }
  | { role: null; slug: string | null; reason: string };

/**
 * Определить роль и персонажа по пути и содержимому.
 *
 * Персонаж берётся из имени каталога, но только если каталог действительно
 * персонажный: `characters/<slug>/<файл>`. Всё, что лежит иначе — в архиве, в
 * подпапках, — персонажу не приписывается. Догадка по имени файла («Твиглет.png
 * — значит Твиглета») здесь не применяется намеренно: имя не доказательство.
 */
export function classifyCharacterAsset(
  relativePath: string,
  facts: MediaFacts,
  video: VideoFacts | null,
  knownSlugs: ReadonlySet<string>
): Classification {
  const parts = relativePath.split('/');
  const fileName = parts.at(-1) ?? '';
  const slug = parts.at(-2) ?? null;
  const inCharactersDir = parts.length === 3 && parts[0] === 'characters';

  if (!inCharactersDir || !slug || !knownSlugs.has(slug)) {
    return {
      role: null,
      slug: null,
      reason: 'файл лежит вне каталога персонажа — привязка была бы догадкой'
    };
  }

  const profile = ASSET_PROFILES.find((candidate) => candidate.fileName === fileName);
  if (!profile) {
    return {
      role: null,
      slug,
      reason: `имя ${fileName} ни одной роли не соответствует`
    };
  }

  if (!profile.matches(facts, video)) {
    const measured =
      facts.width && facts.height
        ? `${facts.width}×${facts.height}`
        : video?.width
          ? `${video.width}×${video.height}, ${video.durationMs ?? '?'} мс`
          : 'размеры не прочитаны';
    return {
      role: null,
      slug,
      reason:
        `имя обещает ${profile.role}, но содержимое не подтвердило: ожидалось ` +
        `${profile.expected}, измерено ${measured}`
    };
  }

  return { role: profile.role, slug };
}
