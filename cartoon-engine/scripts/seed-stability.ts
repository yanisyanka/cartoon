/**
 * Эксперимент: даёт ли один и тот же seed один и тот же файл.
 *
 * От этого зависит `determinism.seedStable` в реестре моделей, а от него —
 * класс воспроизводимости всех ракурсов. Объявлять его по предположению нельзя,
 * поэтому он измеряется.
 *
 * Устройство эксперимента важнее его результата. Запуск восстанавливается НЕ из
 * кода, а из записи происхождения существующего ассета: промпт, seed, параметры
 * и референс читаются из базы. Тем самым проверяется и то, ради чего весь
 * реестр затевался, — достаточно ли записанного, чтобы повторить работу.
 *
 * Что эксперимент НЕ делает:
 *   • не пишет ни одного файла в корень медиа — байты остаются в памяти;
 *   • не создаёт Asset: повтор ради измерения не является продукцией;
 *   • не трогает существующую запись.
 *
 *   npm run experiment:seed -- <относительный путь ассета>
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  findCurrentVersionByPath,
  getEngineDb,
  InvariantError,
  isReady,
  MediaStore,
  NotConfiguredError,
  requireModel
} from '@core/index';
import { createImageEditProvider } from '../apps/cartoon/src/providers';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    throw new NotConfiguredError('Укажите путь ассета, повтор которого проверяем.');
  }

  const store = MediaStore.fromEnv();
  const db = getEngineDb();

  try {
    const asset = await findCurrentVersionByPath(db, target);
    if (!asset?.provenance?.providerId) {
      throw new InvariantError(`${target} не является результатом работы провайдера.`);
    }

    const p = asset.provenance;

    // --- восстановление запуска ИЗ ЗАПИСИ ------------------------------------
    const referenceLink = asset.inputs.find((link) => link.role === 'reference');
    if (!referenceLink) {
      throw new InvariantError('В происхождении нет входа с ролью reference.');
    }

    const parameters = JSON.parse(p.parameters ?? '{}') as Record<string, unknown>;
    const model = requireModel(p.modelKey ?? '');

    console.log('Восстановлено из записи происхождения:');
    console.log(`  референс   ${referenceLink.inputRelativePath}`);
    console.log(`  модель     ${p.modelKey} (${p.modelVersion})`);
    console.log(`  seed       ${p.seed}`);
    console.log(`  шаги/cfg   ${parameters['steps']} / ${parameters['cfg']}`);
    console.log(`  workflow   ${p.workflowHash}`);
    console.log(`  первый sha ${asset.sha256}\n`);

    // --- граф должен быть тем же ---------------------------------------------
    const workflowPath = process.env['COMFYUI_WORKFLOW']?.trim();
    if (!workflowPath) throw new NotConfiguredError('COMFYUI_WORKFLOW не задан.');

    const currentWorkflow = await readFile(workflowPath, 'utf8');
    const currentHash = createHash('sha256').update(currentWorkflow, 'utf8').digest('hex');

    if (currentHash !== p.workflowHash) {
      throw new InvariantError(
        `Граф изменился с момента первого запуска (${currentHash} против ` +
          `${p.workflowHash}). Эксперимент на устойчивость seed при разном ` +
          'графе ничего не измеряет.'
      );
    }
    console.log('Граф совпадает с тем, что был записан.\n');

    // --- повтор ---------------------------------------------------------------
    const provider = createImageEditProvider();
    const status = await provider.configStatus();
    if (!isReady(status)) {
      throw new InvariantError(`Провайдер не готов: ${status.state} — ${status.detail}`);
    }

    const input = {
      reference: {
        fileName: 'ref_front.png',
        bytes: await store.readBytes(referenceLink.inputRelativePath)
      },
      prompt: p.prompt ?? '',
      seed: p.seed ?? '',
      modelKey: model.key,
      parameters
    };

    const startedAt = Date.now();
    const run = await provider.submit(input);
    console.log(`Повтор отправлен: ${run.ref}`);

    for (;;) {
      const state = await provider.poll(run);
      if (state.state === 'succeeded') break;
      if (state.state === 'failed') {
        throw new InvariantError(`Повтор не удался: ${state.detail}`);
      }
      if (Date.now() - startedAt > 20 * 60_000) {
        throw new InvariantError(`Повтор ${run.ref} не завершился за 20 минут.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    const output = await provider.fetch(run);
    const repeatHash = createHash('sha256').update(output.bytes).digest('hex');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    // Байты остаются в памяти. В корень медиа не записывается ничего, поэтому
    // и удалять потом нечего — самый безопасный способ ничего не сломать.
    console.log(`Повтор получен за ${elapsed} с, ${output.bytes.length} байт\n`);
    console.log(`первый  sha256  ${asset.sha256}`);
    console.log(`повтор  sha256  ${repeatHash}`);
    console.log(`размеры         ${asset.sizeBytes} против ${output.bytes.length} байт\n`);

    const identical = repeatHash === asset.sha256;
    console.log(identical ? 'РЕЗУЛЬТАТ: seedStable = true' : 'РЕЗУЛЬТАТ: seedStable = false');
    console.log(
      identical
        ? '  Тот же seed при том же окружении даёт побайтово тот же файл.'
        : '  Тот же seed даёт другой файл. Воспроизводимость по seed недостижима, ' +
            'и записи должны оставаться stochastic.'
    );
    console.log('\nФайлов не создано, Asset не создан, существующая запись не изменена.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${name}: ${message}`);
  process.exitCode = 1;
});
