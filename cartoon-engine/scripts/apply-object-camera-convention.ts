/**
 * Привести два первых ракурса Москина к объектной конвенции.
 *
 * Одноразовый и адресный: он знает два конкретных идентификатора и два
 * конкретных отпечатка и ничего другого не тронет. Общего механизма
 * «переименовать ассет» здесь нет и заводить его не следует — реестр описывает
 * дерево, а не управляет им. Это исключение, и оно живёт в отдельном файле с
 * говорящим именем, чтобы его нельзя было применить случайно.
 *
 * Что произошло. Первые два ракурса названы по движению камеры: «повернуть
 * камеру влево» дало файл three-quarter-left. Но камера, уезжая влево,
 * показывает ПРАВУЮ сторону персонажа, и под принятой объектной конвенцией имя
 * означает обратное. Оба имени зеркально перепутаны — разбор в
 * docs/CE-TASK-003B.md.
 *
 * Что здесь НЕ меняется: байты, sha256, происхождение целиком (включая
 * cameraPhrase, filename_prefix, seed, providerRunRef, workflowJson), version и
 * supersedesId. Провенанс — запись о прошлом: модели действительно было сказано
 * «поверни камеру влево», и переписывать это задним числом нельзя. Меняются
 * ровно два поля классификации: cameraAngle и relativePath.
 *
 * Порядок и откат. Сначала сверяются все ожидания — идентификаторы, отпечатки,
 * текущие значения, свобода целевых путей на диске и в базе. Потом файлы
 * переименовываются через временное имя: имена меняются местами, и без
 * промежуточного шага второй rename затёр бы первый. Потом одна транзакция на
 * обе строки. Если транзакция не прошла — файлы возвращаются к прежним именам,
 * и на диске остаётся ровно то, что было до запуска.
 *
 *   npm run apply:camera-convention
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { getEngineDb, InvariantError, MediaStore } from '@core/index';

/** Что должно лежать в базе и на диске, и во что это превращается. */
const PLAN = [
  {
    id: 'cmspk56ph00005ov69nmstxfw',
    sha256: '2af4d258d567f89082ad8c87ae23b23231867955e3ec5dcd7aa90367e1822a9e',
    from: {
      relativePath: 'characters/01-mossy/turnaround/three-quarter-left.s20260812.png',
      cameraAngle: 'three-quarter-left'
    },
    to: {
      relativePath: 'characters/01-mossy/turnaround/three-quarter-right.s20260812.png',
      cameraAngle: 'three-quarter-right'
    },
    why: 'seed 20260812: на кадре видна правая сторона Москина, разворот ~45°'
  },
  {
    id: 'cmsqmhka6000034v6fvi15pjg',
    sha256: '083a27eeb8dffbb527268fd4fe44b5bb0e2296f0bb30660ae0a7d09d8fdb8bf1',
    from: {
      relativePath: 'characters/01-mossy/turnaround/three-quarter-right.s20260813.png',
      cameraAngle: 'three-quarter-right'
    },
    to: {
      relativePath: 'characters/01-mossy/turnaround/three-quarter-left.s20260813.png',
      cameraAngle: 'three-quarter-left'
    },
    why: 'seed 20260813: на кадре видна левая сторона Москина, разворот ~20–30°'
  }
] as const;

async function sha256Of(store: MediaStore, relativePath: string): Promise<string> {
  const bytes = await readFile(store.resolve(relativePath));
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    console.log('Объектная конвенция: имя ракурса называет сторону ПЕРСОНАЖА.\n');

    // --- 1. сверка ожиданий. Ничего не меняется, пока не сошлось всё ---------
    for (const item of PLAN) {
      const row = await db.asset.findUnique({ where: { id: item.id } });

      if (!row) {
        throw new InvariantError(`Ассета ${item.id} в базе нет. План устарел — остановка.`);
      }
      if (row.sha256 !== item.sha256) {
        throw new InvariantError(
          `У ${item.id} отпечаток ${row.sha256}, а план рассчитан на ${item.sha256}. ` +
            'Это другой файл — остановка.'
        );
      }
      if (row.relativePath !== item.from.relativePath) {
        throw new InvariantError(
          `У ${item.id} путь ${row.relativePath}, а ожидался ${item.from.relativePath}. ` +
            'Похоже, правку уже применяли — остановка.'
        );
      }
      if (row.cameraAngle !== item.from.cameraAngle) {
        throw new InvariantError(
          `У ${item.id} ракурс ${row.cameraAngle}, а ожидался ${item.from.cameraAngle}. ` +
            'Остановка.'
        );
      }

      // Отпечаток считается с диска, а не берётся из базы: сверяется физический
      // файл, который сейчас будут переименовывать.
      const onDisk = await sha256Of(store, item.from.relativePath);
      if (onDisk !== item.sha256) {
        throw new InvariantError(
          `${item.from.relativePath} на диске имеет отпечаток ${onDisk}, ` +
            `а в базе записан ${item.sha256}. Остановка.`
        );
      }

      // Целевой путь обязан быть свободен и на диске, и в реестре.
      if (await store.exists(item.to.relativePath)) {
        throw new InvariantError(`${item.to.relativePath} уже существует на диске. Остановка.`);
      }
      const occupied = await db.asset.findFirst({
        where: { relativePath: item.to.relativePath }
      });
      if (occupied) {
        throw new InvariantError(`${item.to.relativePath} занят в реестре. Остановка.`);
      }

      console.log(`  ✓ сверено: ${item.from.relativePath}`);
      console.log(`      ${item.why}`);
      console.log(`      ${item.from.cameraAngle} → ${item.to.cameraAngle}`);
    }

    // --- 2. переименование через временное имя ------------------------------
    //
    // Имена меняются местами. Без промежуточного шага первый rename занял бы
    // путь, который второму ещё нужен как исходный.
    const staged: { temporary: string; target: string; original: string }[] = [];

    for (const item of PLAN) {
      const temporary = `${item.from.relativePath}.renaming`;
      await rename(store.resolve(item.from.relativePath), store.resolve(temporary));
      staged.push({
        temporary,
        target: item.to.relativePath,
        original: item.from.relativePath
      });
    }

    for (const step of staged) {
      await rename(store.resolve(step.temporary), store.resolve(step.target));
      console.log(`  ✓ файл: ${step.original}\n           → ${step.target}`);
    }

    // --- 3. одна транзакция на обе строки -----------------------------------
    try {
      await db.$transaction(
        PLAN.map((item) =>
          db.asset.update({
            where: { id: item.id },
            data: {
              relativePath: item.to.relativePath,
              cameraAngle: item.to.cameraAngle
            }
          })
        )
      );
    } catch (error) {
      // База не приняла правку — возвращаем файлы как было, чтобы диск и
      // реестр остались согласованы.
      for (const step of staged) {
        await rename(store.resolve(step.target), store.resolve(step.original));
      }
      console.error('\nТранзакция не прошла, файлы возвращены к прежним именам.');
      throw error;
    }

    // --- 4. что получилось ---------------------------------------------------
    console.log('\nПосле правки:');
    for (const item of PLAN) {
      const row = await db.asset.findUnique({ where: { id: item.id } });
      const onDisk = await sha256Of(store, item.to.relativePath);
      console.log(`  ${row?.relativePath}`);
      console.log(`      ракурс ${row?.cameraAngle} · version ${row?.version} · ` +
        `supersedes ${row?.supersedesId ?? 'null'}`);
      console.log(`      sha256 ${row?.sha256}`);
      console.log(`      на диске ${onDisk} · ${onDisk === item.sha256 ? 'байты те же' : 'РАСХОЖДЕНИЕ'}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${name}: ${message}`);
  process.exitCode = 1;
});
