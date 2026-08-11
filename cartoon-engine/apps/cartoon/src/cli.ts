/**
 * CLI движка.
 *
 *   npm run cartoon -- characters import
 *   npm run cartoon -- characters show 01-mossy
 *   npm run cartoon -- canon import
 *   npm run cartoon -- assets import --refs
 *   npm run cartoon -- assets history characters/04-puff/ref_front.png
 *
 * Разбор аргументов написан руками и намеренно: библиотека под него весит
 * больше, чем весь этот файл.
 */
import 'dotenv/config';
import {
  getEngineDb,
  importFiles,
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
import { importCharacterReferences, REFERENCE_ROLE } from './services/reference-import';

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
  }
}

function summarize(outcomes: ImportOutcome[]): number {
  for (const outcome of outcomes) console.log(describeOutcome(outcome));

  const registered = outcomes.filter((o) => o.status === 'registered').length;
  const versions = outcomes.filter((o) => o.status === 'new-version').length;
  const known = outcomes.filter((o) => o.status === 'already-registered').length;
  const problems = outcomes.filter(needsAttention).length;

  console.log(
    `\nЗарегистрировано: ${registered} · новых версий: ${versions} · ` +
      `уже было: ${known} · требует внимания: ${problems}`
  );

  return problems > 0 ? 1 : 0;
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
      console.log(
        `  ${mark} ${character.slug}  ${character.nameRu} — ${character.title}`
      );
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

/** «Дай эталон Москина» — запрос, ради которого задача и делалась. */
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
    const own = current.filter((asset) => asset.characterId === character.id);

    if (own.length === 0) {
      console.log('\nАссетов нет.');
      return 0;
    }

    for (const asset of own) {
      console.log(`\nAsset:\n    ${asset.role ?? '(без роли)'}`);
      console.log(`\npath:\n    ${asset.relativePath}`);
      console.log(`\nsha256:\n    ${asset.sha256}`);
      console.log(`\nversion:\n    ${asset.version}`);
      console.log(`\nreproducibility:\n    ${asset.provenance?.reproducibility ?? '—'}`);
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
  const useRefs = args.includes('--refs');
  const explicit = args.filter((arg) => !arg.startsWith('--'));

  if (useRefs && explicit.length > 0) {
    console.error('Нельзя сочетать --refs со списком путей: выберите одно.');
    return 1;
  }

  const store = MediaStore.fromEnv();
  console.log(`Корень медиа: ${store.rootPath}`);

  if (dryRun) {
    // Сухой прогон читает файлы и считает отпечатки, но в базу не ходит вовсе.
    const targets = useRefs ? await store.find('ref_front.png', 'characters') : explicit;
    if (targets.length === 0) {
      console.error('Нечего импортировать.');
      return 1;
    }

    console.log(`Файлов к обработке: ${targets.length} (сухой прогон)\n`);
    for (const target of targets) {
      const facts = await store.describe(target);
      console.log(`  ? ${facts.relativePath}`);
      console.log(
        `      ${facts.mimeType}, ${formatBytes(facts.sizeBytes)} байт, sha256 ${facts.sha256}`
      );
    }
    console.log('\nСухой прогон: база не изменялась.');
    return 0;
  }

  return withDb(async (db) => {
    if (useRefs) {
      const outcomes = await importCharacterReferences({ store, db });
      console.log(`Эталонов к обработке: ${outcomes.length}, роль ${REFERENCE_ROLE}\n`);
      return summarize(outcomes);
    }

    if (explicit.length === 0) {
      console.error(
        'Нечего импортировать. Укажите пути относительно MEDIA_ROOT либо ' +
          'флаг --refs, чтобы взять все эталоны персонажей.'
      );
      return 1;
    }

    console.log(`Файлов к обработке: ${explicit.length}\n`);
    const outcomes = await importFiles(
      { store, db },
      explicit.map((relativePath) => ({ relativePath }))
    );
    return summarize(outcomes);
  });
}

function printAsset(asset: AssetView, characterName: string | undefined): void {
  console.log(`${asset.relativePath}  v${asset.version}`);
  console.log(
    `    ${asset.role ?? '(без роли)'} · ${characterName ?? '(без персонажа)'} · ` +
      `${asset.mimeType} · ${formatBytes(asset.sizeBytes)} байт`
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
      '  cartoon characters show <slug>         персонаж и его эталон',
      '',
      '  cartoon canon import                   правила канона из CAST.md',
      '  cartoon canon list',
      '',
      '  cartoon assets import --refs           эталоны с ролью и персонажем',
      '  cartoon assets import <путь> […]       конкретные файлы',
      '  cartoon assets import … --dry-run      посчитать, ничего не записывая',
      '  cartoon assets list [--all]            текущие версии либо все',
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

  const key = `${group} ${command}`;
  switch (key) {
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
