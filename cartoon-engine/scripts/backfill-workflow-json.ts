/**
 * Досохранить текст workflow у ассетов, где записан только его отпечаток.
 *
 * Нужно ровно один раз: ракурс Москина сделан до того, как текст графа стали
 * хранить. Отпечаток у него записан, файл графа с тех пор не менялся — значит
 * текст можно восстановить, ничего не выдумывая.
 *
 * Здесь нет ни одной догадки. Файл читается, считается его sha256 и
 * СРАВНИВАЕТСЯ с тем, что записан в происхождении. Не совпало — скрипт
 * отказывается: значит граф после запуска правили, и подставить его текущий
 * текст задним числом означало бы соврать о прошлом.
 *
 *   npm run backfill:workflow
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getEngineDb, listAssets, NotConfiguredError } from '@core/index';

async function main(): Promise<void> {
  const workflowPath = process.env['COMFYUI_WORKFLOW']?.trim();
  if (!workflowPath) {
    throw new NotConfiguredError('COMFYUI_WORKFLOW не задан.');
  }

  const raw = await readFile(workflowPath, 'utf8');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');

  console.log(`Файл графа: ${workflowPath}`);
  console.log(`sha256:     ${hash}\n`);

  const db = getEngineDb();
  try {
    const pending = (await listAssets(db)).filter(
      (asset) =>
        asset.provenance?.providerId &&
        asset.provenance.workflowHash &&
        !asset.provenance.workflowJson
    );

    if (pending.length === 0) {
      console.log('Досохранять нечего: у всех произведённых ассетов текст графа на месте.');
      return;
    }

    let filled = 0;
    for (const asset of pending) {
      const recorded = asset.provenance?.workflowHash;

      if (recorded !== hash) {
        console.error(
          `  ✗ ${asset.relativePath}\n` +
            `      записан отпечаток ${recorded},\n` +
            `      а у файла сейчас   ${hash}.\n` +
            '      Граф правили после запуска. Восстановить его текст нельзя — ' +
            'запись остаётся без него, и это честнее подмены.'
        );
        continue;
      }

      await db.provenance.update({
        where: { assetId: asset.id },
        data: { workflowJson: raw }
      });
      console.log(`  ✓ ${asset.relativePath} — текст графа сохранён (${raw.length} байт)`);
      filled += 1;
    }

    console.log(`\nЗаполнено: ${filled} из ${pending.length}`);
    if (filled !== pending.length) process.exitCode = 1;
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
