/**
 * Инвентаризация: что физически лежит на диске и что об этом известно.
 *
 * Ничего не пишет — ни в базу, ни на диск. Задача одна: собрать факты и
 * сопоставить их с реестром, чтобы стало видно, где реестр отстаёт от диска.
 */
import {
  listAssetAliases,
  listAssets,
  MediaStore,
  type AssetView,
  type EngineDb,
  type MediaFacts
} from '@core/index';
import { probeVideo, type VideoFacts } from '../domain/video-probe';

/** Расширения, которые считаются медиа для целей инвентаризации. */
export const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.wav'];

export type InventoryEntry = {
  facts: MediaFacts;
  /** Метаданные видео. null — файл не видео либо прочитать не удалось. */
  video: VideoFacts | null;
  /** Почему видео не прочитано. null — вопрос не возникал. */
  videoProblem: string | null;
  /** Ассет, зарегистрированный по этому пути. */
  asset: AssetView | null;
  /** Ассет, чьи байты совпадают, но зарегистрирован он под другим путём. */
  sameContentAs: AssetView | null;
  /** Записан ли этот путь псевдонимом известного ассета. */
  aliasOf: AssetView | null;
};

function hasMediaExtension(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return MEDIA_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Собрать все медиафайлы поддерева и сопоставить их с реестром.
 *
 * Обход идёт через MediaStore: правило «никаких абсолютных путей снаружи»
 * действует и здесь. Файлы читаются целиком ради отпечатка — на 68 файлах это
 * около полуминуты, и это цена честного ответа вместо доверия именам.
 */
export async function takeInventory(
  deps: { store: MediaStore; db: EngineDb },
  withinRelativeDir = '.'
): Promise<InventoryEntry[]> {
  const all = await deps.store.findAll(withinRelativeDir);
  const media = all.filter(hasMediaExtension).sort();

  const assets = await listAssets(deps.db);
  const aliases = await listAssetAliases(deps.db);

  const byPath = new Map<string, AssetView>();
  const bySha = new Map<string, AssetView>();
  for (const asset of assets) {
    const known = byPath.get(asset.relativePath);
    if (!known || asset.version > known.version) byPath.set(asset.relativePath, asset);
    bySha.set(asset.sha256, asset);
  }

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const aliasByPath = new Map(aliases.map((alias) => [alias.relativePath, alias]));

  const entries: InventoryEntry[] = [];

  for (const relativePath of media) {
    const facts = await deps.store.describe(relativePath);

    let video: VideoFacts | null = null;
    let videoProblem: string | null = null;
    if (facts.type === 'video') {
      const probe = await probeVideo(facts.absolutePath);
      if (probe.ok) video = probe.facts;
      else videoProblem = `${probe.reason}: ${probe.detail}`;
    }

    const asset = byPath.get(facts.relativePath) ?? null;
    const sameContent = bySha.get(facts.sha256) ?? null;
    const alias = aliasByPath.get(facts.relativePath);

    entries.push({
      facts,
      video,
      videoProblem,
      asset,
      // «Те же байты в другом месте» — только если это действительно другое
      // место: совпадение с самим собой информацией не является.
      sameContentAs: sameContent && sameContent.relativePath !== facts.relativePath ? sameContent : null,
      aliasOf: alias ? (assetById.get(alias.assetId) ?? null) : null
    });
  }

  return entries;
}
