/**
 * CLI движка.
 *
 *   npm run cartoon -- characters import
 *   npm run cartoon -- characters show 01-mossy
 *   npm run cartoon -- canon import
 *   npm run cartoon -- assets inventory characters
 *   npm run cartoon -- assets import --characters
 *   npm run cartoon -- assets import --archive
 *   npm run cartoon -- assets history characters/04-puff/ref_front.png
 *
 * Разбор аргументов написан руками и намеренно: библиотека под него весит
 * больше, чем весь этот файл.
 */
import 'dotenv/config';
import {
  getEngineDb,
  importFiles,
  listAssetAliases,
  listAssets,
  listCurrentAssets,
  listVersionsByPath,
  MediaStore,
  needsAttention,
  type AssetView,
  type EngineDb,
  type ImportOutcome
} from '@core/index';
import { listCharacters, findCharacterBySlug } from './repositories/characters';
import { listCanonRules } from './repositories/canon-rules';
import { importCharacters } from './services/character-import';
import { importCanonRules } from './services/canon-import';
import {
  ARCHIVE_DIR,
  importArchive,
  importCharacterAssets,
  type ClassifiedImport
} from './services/character-assets-import';
import { takeInventory } from './services/inventory';

const ARCHIVE_NOTE = 'оригинал, из которого материал копировался в папку персонажа';

function formatBytes(value: number): string {
  return value.toLocaleString('ru-RU');
}

function describeOutcome(outcome: ImportOutcome): string {
  switch (outcome.status) {
    case 'registered':
      return (
        `  + ${outcome.asset.relativePath}  (версия ${outcome.asset.version})\n` +
        `      ${outcome.asset.mimeType}, ${formatBytes(outcome.asset.sizeBytes)} байт\n` +
        `      sha256 ${outcome.asset.sha256}`
      );
    case 'new-version':
      return (
        `  ↑ ${outcome.asset.relativePath}  — новая версия ${outcome.asset.version}\n` +
        `      было  v${outcome.supersededAsset.version}: ${outcome.supersededAsset.sha256}\n` +
        `      стало v${outcome.asset.version}: ${outcome.asset.sha256}\n` +
        '      Прежняя запись сохранена целиком, файл на диске не удалён.'
      );
    case 'already-registered':
      return outcome.classified
        ? `  ~ ${outcome.asset.relativePath} — проставлены роль и персонаж`
        : `  = ${outcome.asset.relativePath} — уже зарегистрирован, дубликат не создан`;
    case 'content-conflict':
      return (
        `  ! ${outcome.requestedPath}\n` +
        `      те же байты уже зарегистрированы как ${outcome.asset.relativePath}.\n` +
        '      В дереве лежит копия файла. Новая строка не создана.'
      );
    case 'older-version-on-disk':
      return (
        `  ! ${outcome.asset.relativePath}\n` +
        `      на диске байты версии ${outcome.asset.version}, ` +
        `а текущей числится ${outcome.currentAsset.version}.\n` +
        '      Похоже на откат перерендера. Новая строка не создана.'
      );
    case 'alias-recorded':
      return outcome.alreadyKnown
        ? `  = ${outcome.aliasPath} — копия уже была записана`
        : `  ⇢ ${outcome.aliasPath}\n` +
          `      те же байты, что у ${outcome.asset.relativePath}.\n` +
          '      Записано как ещё одно место того же ассета.';
  }
}

function summarize(outcomes: ImportOutcome[]): number {
  const registered = outcomes.filter((o) => o.status === 'registered').length;
  const versions = outcomes.filter((o) => o.status === 'new-version').length;
  const known = outcomes.filter((o) => o.status === 'already-registered').length;
  const aliases = outcomes.filter((o) => o.status === 'alias-recorded').length;
  const problems = outcomes.filter(needsAttention).length;

  console.log(
    `\nЗарегистрировано: ${registered} · новых версий: ${versions} · ` +
      `псевдонимов: ${aliases} · уже было: ${known} · требует внимания: ${problems}`
  );

  return problems > 0 ? 1 : 0;
}

function summarizeClassified(results: ClassifiedImport[]): number {
  for (const result of results) {
    if (result.outcome) console.log(describeOutcome(result.outcome));
    if (result.unclassifiedReason) {
      console.log(`      без роли: ${result.unclassifiedReason}`);
    }
  }

  const outcomes = results
    .map((result) => result.outcome)
    .filter((outcome): outcome is ImportOutcome => outcome !== null);
  const code = summarize(outcomes);

  const unclassified = results.filter((result) => result.unclassifiedReason !== null).length;
  if (unclassified > 0) console.log(`Без роли: ${unclassified}`);

  return code;
}

async function withDb(run: (db: EngineDb) => Promise<number>): Promise<number> {
  const db = getEngineDb();
  try {
    return await run(db);
  } finally {
    await db.$disconnect();
  }
}

// --- characters --------------------------------------------------------------

async function commandCharactersImport(): Promise<number> {
  const store = MediaStore.fromEnv();

  return withDb(async (db) => {
    const outcomes = await importCharacters({ store, db });

    for (const { character, status } of outcomes) {
      const mark = status === 'created' ? '+' : status === 'updated' ? '~' : '=';
      console.log(`  ${mark} ${character.slug}  ${character.nameRu} — ${character.title}`);
    }

    const created = outcomes.filter((o) => o.status === 'created').length;
    const updated = outcomes.filter((o) => o.status === 'updated').length;
    console.log(
      `\nПерсонажей: ${outcomes.length} · заведено: ${created} · обновлено: ${updated}`
    );
    return 0;
  });
}

async function commandCharactersList(): Promise<number> {
  return withDb(async (db) => {
    const characters = await listCharacters(db);
    if (characters.length === 0) {
      console.log('Персонажей нет. Сначала: cartoon characters import.');
      return 0;
    }

    for (const character of characters) {
      console.log(
        `${String(character.number).padStart(2, '0')}  ${character.nameRu} / ${character.name}`
      );
      console.log(`    ${character.title}`);
      console.log(
        `    якорь ${character.colorAnchors.join(' + ')} · рост ${character.heightRatio} · ${character.frequency}`
      );
    }
    console.log(`\nВсего: ${characters.length}`);
    return 0;
  });
}

/** «Дай эталон Москина» — запрос, ради которого делалась CE-TASK-002. */
async function commandCharactersShow(slug: string | undefined): Promise<number> {
  if (!slug) {
    console.error('Укажите slug персонажа, например 01-mossy.');
    return 1;
  }

  return withDb(async (db) => {
    const character = await findCharacterBySlug(db, slug);
    if (!character) {
      console.error(`Персонажа ${slug} в базе нет.`);
      return 1;
    }

    console.log(`Character:\n    ${character.nameRu} / ${character.name}`);
    console.log(`    ${character.title}`);
    console.log(
      `    якорь ${character.colorAnchors.join(' + ')} · рост ${character.heightRatio} · ${character.frequency}`
    );
    console.log(`\nПаспорт:\n    ${character.sourcePath}`);
    console.log(`    sha256 ${character.sourceSha256}`);

    const current = await listCurrentAssets(db);
    const own = current
      .filter((asset) => asset.characterId === character.id)
      .sort((a, b) => (a.role ?? '').localeCompare(b.role ?? ''));

    if (own.length === 0) {
      console.log('\nАссетов нет.');
      return 0;
    }

    for (const asset of own) {
      console.log(`\nAsset:            ${asset.role ?? '(без роли)'}`);
      console.log(`path:             ${asset.relativePath}`);
      console.log(`sha256:           ${asset.sha256}`);
      console.log(`version:          ${asset.version}`);
      console.log(`reproducibility:  ${asset.provenance?.reproducibility ?? '—'}`);
    }

    return 0;
  });
}

// --- canon -------------------------------------------------------------------

async function commandCanonImport(): Promise<number> {
  return withDb(async (db) => {
    const outcomes = await importCanonRules(db);

    for (const { rule, status } of outcomes) {
      const mark = status === 'created' ? '+' : status === 'updated' ? '~' : '=';
      console.log(`  ${mark} ${rule.code}  [${rule.severity}]`);
    }

    const created = outcomes.filter((o) => o.status === 'created').length;
    console.log(`\nПравил: ${outcomes.length} · заведено: ${created}`);
    return 0;
  });
}

async function commandCanonList(): Promise<number> {
  return withDb(async (db) => {
    const rules = await listCanonRules(db);
    if (rules.length === 0) {
      console.log('Правил нет. Сначала: cartoon canon import.');
      return 0;
    }

    for (const rule of rules) {
      console.log(`${rule.code}  [${rule.severity}]${rule.enabled ? '' : '  ВЫКЛЮЧЕНО'}`);
      console.log(`    ${rule.description}`);
      console.log(`    источник: ${rule.source}`);
    }
    console.log(`\nВсего: ${rules.length}`);
    return 0;
  });
}

// --- assets ------------------------------------------------------------------

async function commandAssetsImport(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const useCharacters = args.includes('--characters') || args.includes('--refs');
  const useArchive = args.includes('--archive');
  const explicit = args.filter((arg) => !arg.startsWith('--'));

  if ([useCharacters, useArchive, explicit.length > 0].filter(Boolean).length > 1) {
    console.error('Выберите одно: --characters, --archive или список путей.');
    return 1;
  }

  const store = MediaStore.fromEnv();
  console.log(`Корень медиа: ${store.rootPath}`);

  if (dryRun) {
    // Сухой прогон читает файлы и считает отпечатки, но в базу не ходит вовсе.
    const targets = useCharacters
      ? await store.findAll('characters')
      : useArchive
        ? await store.findAll(ARCHIVE_DIR)
        : explicit;

    if (targets.length === 0) {
      console.error('Нечего импортировать.');
      return 1;
    }

    console.log(`Файлов к обработке: ${targets.length} (сухой прогон)\n`);
    for (const target of targets) {
      const facts = await store.describe(target);
      const frame = facts.width && facts.height ? `, ${facts.width}×${facts.height}` : '';
      console.log(`  ? ${facts.relativePath}`);
      console.log(
        `      ${facts.mimeType}${frame}, ${formatBytes(facts.sizeBytes)} байт, sha256 ${facts.sha256}`
      );
    }
    console.log('\nСухой прогон: база не изменялась.');
    return 0;
  }

  return withDb(async (db) => {
    if (useCharacters) {
      const results = await importCharacterAssets({ store, db });
      console.log(`Файлов персонажей: ${results.length}\n`);
      return summarizeClassified(results);
    }

    if (useArchive) {
      const results = await importArchive({ store, db }, ARCHIVE_DIR, ARCHIVE_NOTE);
      console.log(`Архивных файлов: ${results.length}\n`);
      return summarizeClassified(results);
    }

    if (explicit.length === 0) {
      console.error(
        'Нечего импортировать. Укажите пути относительно MEDIA_ROOT либо флаг ' +
          '--characters (материал персонажей) или --archive (оригиналы).'
      );
      return 1;
    }

    console.log(`Файлов к обработке: ${explicit.length}\n`);
    const outcomes = await importFiles(
      { store, db },
      explicit.map((relativePath) => ({ relativePath }))
    );
    for (const outcome of outcomes) console.log(describeOutcome(outcome));
    return summarize(outcomes);
  });
}

function printAsset(asset: AssetView, characterName: string | undefined): void {
  const frame = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
  console.log(`${asset.relativePath}  v${asset.version}`);
  console.log(
    `    ${asset.role ?? '(без роли)'} · ${characterName ?? '(без персонажа)'} · ` +
      `${asset.mimeType}${frame} · ${formatBytes(asset.sizeBytes)} байт`
  );
  console.log(`    sha256 ${asset.sha256}`);
  console.log(
    `    происхождение: ${asset.provenance?.producedBy ?? '—'} · ` +
      `воспроизводимость: ${asset.provenance?.reproducibility ?? '—'}`
  );
}

async function commandAssetsList(args: string[]): Promise<number> {
  const all = args.includes('--all');

  return withDb(async (db) => {
    const characters = await listCharacters(db);
    const names = new Map(characters.map((c) => [c.id, c.nameRu]));

    const assets = all ? await listAssets(db) : await listCurrentAssets(db);
    if (assets.length === 0) {
      console.log('Реестр пуст.');
      return 0;
    }

    for (const asset of assets) {
      printAsset(asset, asset.characterId ? names.get(asset.characterId) : undefined);
    }

    console.log(
      `\nВсего: ${assets.length}${all ? ' (включая устаревшие версии)' : ' (текущие версии)'}`
    );
    return 0;
  });
}

async function commandAssetsAliases(): Promise<number> {
  return withDb(async (db) => {
    const aliases = await listAssetAliases(db);
    if (aliases.length === 0) {
      console.log('Псевдонимов нет.');
      return 0;
    }

    const assets = await listAssets(db);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    for (const alias of aliases) {
      console.log(alias.relativePath);
      console.log(`    → ${byId.get(alias.assetId)?.relativePath ?? '(ассет не найден)'}`);
      if (alias.note) console.log(`    ${alias.note}`);
    }
    console.log(`\nВсего: ${aliases.length}`);
    return 0;
  });
}

/** Что физически лежит на диске и что об этом знает реестр. Ничего не пишет. */
async function commandAssetsInventory(args: string[]): Promise<number> {
  const within = args.find((arg) => !arg.startsWith('--')) ?? '.';
  const store = MediaStore.fromEnv();

  return withDb(async (db) => {
    const entries = await takeInventory({ store, db }, within);
    const characters = await listCharacters(db);
    const names = new Map(characters.map((c) => [c.id, c.nameRu]));

    for (const entry of entries) {
      const { facts } = entry;
      const frame =
        facts.width && facts.height
          ? `${facts.width}×${facts.height}`
          : entry.video?.width
            ? `${entry.video.width}×${entry.video.height}`
            : '—';
      const duration = entry.video?.durationMs
        ? `, ${(entry.video.durationMs / 1000).toFixed(2)} с`
        : '';

      let state: string;
      if (entry.asset) {
        const who = entry.asset.characterId ? names.get(entry.asset.characterId) : null;
        state =
          `реестр: ${entry.asset.role ?? 'роль не задана'}` +
          `${who ? ` · ${who}` : ''} · v${entry.asset.version}`;
      } else if (entry.aliasOf) {
        state = `псевдоним → ${entry.aliasOf.relativePath}`;
      } else if (entry.sameContentAs) {
        state = `те же байты, что у ${entry.sameContentAs.relativePath} — НЕ зарегистрирован`;
      } else {
        state = 'НЕ зарегистрирован';
      }

      console.log(facts.relativePath);
      console.log(
        `    ${facts.mimeType} · ${frame}${duration} · ${formatBytes(facts.sizeBytes)} байт`
      );
      console.log(`    sha256 ${facts.sha256.slice(0, 32)}…`);
      console.log(`    ${state}`);
      if (entry.videoProblem) console.log(`    ⚠ ${entry.videoProblem}`);
    }

    const registered = entries.filter((e) => e.asset).length;
    const aliased = entries.filter((e) => !e.asset && e.aliasOf).length;
    const duplicates = entries.filter((e) => !e.asset && !e.aliasOf && e.sameContentAs).length;
    const unknown = entries.filter((e) => !e.asset && !e.aliasOf && !e.sameContentAs).length;

    console.log(
      `\nФайлов: ${entries.length} · в реестре: ${registered} · псевдонимов: ${aliased} · ` +
        `копий известного: ${duplicates} · неизвестных: ${unknown}`
    );
    return 0;
  });
}

async function commandAssetsHistory(relativePath: string | undefined): Promise<number> {
  if (!relativePath) {
    console.error('Укажите путь, например characters/04-puff/ref_front.png');
    return 1;
  }

  return withDb(async (db) => {
    const versions = await listVersionsByPath(db, relativePath);
    if (versions.length === 0) {
      console.log(`По пути ${relativePath} записей нет.`);
      return 0;
    }

    for (const asset of versions) {
      const mark = asset.version === versions.length ? '→' : ' ';
      console.log(
        `${mark} v${asset.version}  ${asset.sha256}  ${formatBytes(asset.sizeBytes)} байт  ${asset.createdAt}`
      );
    }
    console.log(`\nВерсий: ${versions.length}. Стрелка — текущая.`);
    return 0;
  });
}

// --- разбор аргументов -------------------------------------------------------

function usage(): void {
  console.log(
    [
      'Использование:',
      '  cartoon characters import              персонажи из character.md',
      '  cartoon characters list',
      '  cartoon characters show <slug>         персонаж и его ассеты',
      '',
      '  cartoon canon import                   правила канона из CAST.md',
      '  cartoon canon list',
      '',
      '  cartoon assets inventory [подкаталог]  что на диске и что знает реестр',
      '  cartoon assets import --characters     материал персонажей с ролями',
      '  cartoon assets import --archive        оригиналы: копии → псевдонимы',
      '  cartoon assets import <путь> […]       конкретные файлы',
      '  cartoon assets import … --dry-run      посчитать, ничего не записывая',
      '  cartoon assets list [--all]            текущие версии либо все',
      '  cartoon assets aliases                 вторые места известных байтов',
      '  cartoon assets history <путь>          история версий по пути'
    ].join('\n')
  );
}

async function main(): Promise<number> {
  const [group, command, ...rest] = process.argv.slice(2);

  if (!group || !command) {
    usage();
    return group ? 1 : 0;
  }

  switch (`${group} ${command}`) {
    case 'characters import':
      return commandCharactersImport();
    case 'characters list':
      return commandCharactersList();
    case 'characters show':
      return commandCharactersShow(rest[0]);
    case 'canon import':
      return commandCanonImport();
    case 'canon list':
      return commandCanonList();
    case 'assets import':
      return commandAssetsImport(rest);
    case 'assets list':
      return commandAssetsList(rest);
    case 'assets aliases':
      return commandAssetsAliases();
    case 'assets inventory':
      return commandAssetsInventory(rest);
    case 'assets history':
      return commandAssetsHistory(rest[0]);
    default:
      usage();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n${name}: ${message}`);
    process.exitCode = 1;
  });
