/**
 * Доменные типы ассета.
 *
 * Ни Prisma, ни файловой системы: только то, чем ассет является для остальной
 * системы. Строку в базе описывает репозиторий, физический файл — MediaStore.
 */
import type { MediaKind } from './media-store';
import type { ProducedBy, Reproducibility } from './provenance';

/** Ассет в том виде, в каком его отдают CLI и проверки. */
export type AssetView = {
  id: string;
  relativePath: string;
  type: MediaKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Размеры кадра. null у видео и неразбираемых форматов. */
  width: number | null;
  height: number | null;
  /** Чем файл является. null — ещё не классифицирован. */
  role: string | null;
  /** Кто изображён. null — файл не привязан к персонажу. */
  characterId: string | null;
  /** Номер версии по этому пути, начиная с 1. */
  version: number;
  /** Предыдущая версия по тому же пути. null у первой. */
  supersedesId: string | null;
  createdAt: string;
  provenance: AssetProvenanceView | null;
  /** Из чего сделан. Пусто у импортированных. */
  inputs: AssetInputView[];
};

/** Происхождение в том виде, в каком его читают CLI и проверки. */
export type AssetProvenanceView = {
  producedBy: ProducedBy;
  reproducibility: Reproducibility;
  note: string | null;
  providerId: string | null;
  modelKey: string | null;
  modelVersion: string | null;
  prompt: string | null;
  seed: string | null;
  /** JSON. Разбирается вызывающим — ядро в него не заглядывает. */
  parameters: string | null;
  workflowHash: string | null;
  workflowJson: string | null;
  providerRunRef: string | null;
  envFingerprint: string | null;
  envFingerprintHash: string | null;
  spend: string | null;
};

export type AssetInputView = {
  /** Ассет, послуживший входом. */
  inputAssetId: string;
  /** Его путь — чтобы происхождение читалось без второго запроса. */
  inputRelativePath: string;
  /** Чем он послужил: 'reference'. */
  role: string;
};

/** Классификация, которую вызывающий знает, а ядро — нет. */
export type AssetClassification = {
  role?: string;
  characterId?: string;
};

/**
 * Чем закончилась попытка зарегистрировать файл.
 *
 * Пять исходов, и каждый требует от человека своего действия.
 *
 *   registered             путь увиден впервые — версия 1;
 *   new-version            тот же путь, другие байты — файл перерендерили;
 *   already-registered     тот же путь, те же байты — норма при повторе;
 *   content-conflict       те же байты по ДРУГОМУ пути — в дереве дубликат;
 *   older-version-on-disk  на диске лежат байты УЖЕ УСТАРЕВШЕЙ версии.
 *
 * Последний исход выглядит экзотикой, но он прямое следствие версионирования:
 * откатив неудачный перерендер, человек получает на диске байты, которые
 * система числит устаревшими. Ответить «уже зарегистрировано» здесь означало
 * бы скрыть расхождение между диском и реестром.
 */
export type ImportOutcome =
  | { status: 'registered'; asset: AssetView }
  | {
      status: 'new-version';
      asset: AssetView;
      /** Версия, которая была текущей до этой. Не изменена и не удалена. */
      supersededAsset: AssetView;
    }
  | {
      status: 'already-registered';
      asset: AssetView;
      /** true — у записи проставлены роль и/или персонаж, которых не было. */
      classified: boolean;
    }
  | {
      status: 'content-conflict';
      /** Ассет, под которым эти байты уже зарегистрированы. */
      asset: AssetView;
      /** Путь, по которому те же байты встретились сейчас. */
      requestedPath: string;
    }
  | {
      status: 'older-version-on-disk';
      /** Версия, чьи байты лежат на диске. */
      asset: AssetView;
      /** Версия, которую реестр числит текущей. */
      currentAsset: AssetView;
    }
  | {
      status: 'alias-recorded';
      /** Ассет, чьи байты лежат по этому пути. */
      asset: AssetView;
      /** Путь копии, записанный как ещё одно место тех же байтов. */
      aliasPath: string;
      /** true — псевдоним уже был записан раньше. */
      alreadyKnown: boolean;
    };

/** Появилась ли в результате этого вызова новая строка. */
export function createdNewRow(outcome: ImportOutcome): boolean {
  return outcome.status === 'registered' || outcome.status === 'new-version';
}

/** Требует ли исход внимания человека. */
export function needsAttention(outcome: ImportOutcome): boolean {
  return outcome.status === 'content-conflict' || outcome.status === 'older-version-on-disk';
}
