/**
 * CLI движка.
 *
 *   npm run cartoon -- assets import --refs
 *   npm run cartoon -- assets import characters/01-mossy/ref_front.png
 *   npm run cartoon -- assets import --refs --dry-run
 *   npm run cartoon -- assets list
 *
 * Разбор аргументов написан руками и намеренно: библиотека под него весит
 * больше, чем весь этот файл, а команд пока две.
 */
import 'dotenv/config';
import {
  getEngineDb,
  importFiles,
  listAssets,
  MediaStore,
  type ImportOutcome
} from '@core/index';

/** Имя файла-эталона персонажа. Единственное знание о предметной области здесь. */
const REFERENCE_FILE = 'ref_front.png';
const CHARACTERS_DIR = 'characters';

function formatBytes(value: number): string {
  return value.toLocaleString('ru-RU');
}

function describeOutcome(outcome: ImportOutcome): string {
  switch (outcome.status) {
    case 'registered':
      return `  + ${outcome.asset.relativePath}\n` +
        `      ${outcome.asset.mimeType}, ${formatBytes(outcome.asset.sizeBytes)} байт\n` +
        `      sha256 ${outcome.asset.sha256}`;
    case 'already-registered':
      return `  = ${outcome.asset.relativePath} — уже зарегистрирован, дубликат не создан`;
    case 'content-conflict':
      return `  ! ${outcome.requestedPath}\n` +
        `      те же байты уже зарегистрированы как ${outcome.asset.relativePath}.\n` +
        '      В дереве лежит копия файла. Новая строка не создана.';
    case 'content-changed':
      return `  ! ${outcome.asset.relativePath}\n` +
        `      записан с sha256 ${outcome.asset.sha256},\n` +
        `      а на диске сейчас   ${outcome.currentSha256}.\n` +
        '      Файл переделали. Версионирования ассетов пока нет, строка не тронута.';
  }
}

async function commandImport(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const useRefs = args.includes('--refs');
  const explicit = args.filter((arg) => !arg.startsWith('--'));

  const store = MediaStore.fromEnv();

  let targets: string[];
  if (useRefs) {
    targets = await store.find(REFERENCE_FILE, CHARACTERS_DIR);
    if (explicit.length > 0) {
      console.error('Нельзя сочетать --refs со списком путей: выберите одно.');
      return 1;
    }
  } else {
    targets = explicit;
  }

  if (targets.length === 0) {
    console.error(
      'Нечего импортировать. Укажите пути относительно MEDIA_ROOT либо ' +
        `флаг --refs, чтобы взять все ${REFERENCE_FILE} из ${CHARACTERS_DIR}/.`
    );
    return 1;
  }

  console.log(`Корень медиа: ${store.rootPath}`);
  console.log(`Файлов к обработке: ${targets.length}${dryRun ? ' (сухой прогон)' : ''}\n`);

  if (dryRun) {
    // Сухой прогон читает файлы и считает отпечатки, но в базу не ходит вовсе:
    // так можно убедиться, что дерево то самое, ничего не записав.
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

  const db = getEngineDb();
  try {
    const outcomes = await importFiles({ store, db }, targets);

    for (const outcome of outcomes) {
      console.log(describeOutcome(outcome));
    }

    const registered = outcomes.filter((o) => o.status === 'registered').length;
    const known = outcomes.filter((o) => o.status === 'already-registered').length;
    const problems = outcomes.filter(
      (o) => o.status === 'content-conflict' || o.status === 'content-changed'
    ).length;

    console.log(
      `\nЗарегистрировано: ${registered} · уже было: ${known} · требует внимания: ${problems}`
    );

    return problems > 0 ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

async function commandList(): Promise<number> {
  const db = getEngineDb();
  try {
    const assets = await listAssets(db);

    if (assets.length === 0) {
      console.log('Реестр пуст.');
      return 0;
    }

    for (const asset of assets) {
      console.log(asset.relativePath);
      console.log(
        `    ${asset.type} · ${asset.mimeType} · ${formatBytes(asset.sizeBytes)} байт`
      );
      console.log(`    sha256 ${asset.sha256}`);
      console.log(
        `    происхождение: ${asset.provenance?.producedBy ?? '—'} · ` +
          `воспроизводимость: ${asset.provenance?.reproducibility ?? '—'}`
      );
    }

    console.log(`\nВсего: ${assets.length}`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

function usage(): void {
  console.log(
    [
      'Использование:',
      '  cartoon assets import --refs            все ref_front.png из characters/',
      '  cartoon assets import <путь> [<путь>…]  конкретные файлы',
      '  cartoon assets import … --dry-run       посчитать, ничего не записывая',
      '  cartoon assets list                     что уже в реестре'
    ].join('\n')
  );
}

async function main(): Promise<number> {
  const [group, command, ...rest] = process.argv.slice(2);

  if (group !== 'assets' || !command) {
    usage();
    return group ? 1 : 0;
  }

  switch (command) {
    case 'import':
      return commandImport(rest);
    case 'list':
      return commandList();
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
    // Типы ошибок ядра различимы, и человеку важно имя: «файла нет» и «файл не
    // тот, чем притворяется» требуют разных действий.
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n${name}: ${message}`);
    process.exitCode = 1;
  });
