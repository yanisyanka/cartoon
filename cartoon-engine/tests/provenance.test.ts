import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvariantError } from '../packages/core/src/errors';
import {
  assertValidProvenance,
  importedProvenance
} from '../packages/core/src/provenance';

test('provenance: импорт — это всегда unknown', () => {
  const draft = importedProvenance();

  assert.equal(draft.producedBy, 'import');
  assert.equal(draft.reproducibility, 'unknown');
  assert.ok(draft.note && draft.note.length > 0);
});

test('provenance: собственная пометка сохраняется', () => {
  const draft = importedProvenance('эталон из прошлой итерации');

  assert.equal(draft.note, 'эталон из прошлой итерации');
  assert.equal(draft.reproducibility, 'unknown');
});

test('provenance: корректное происхождение проходит', () => {
  assert.doesNotThrow(() => assertValidProvenance(importedProvenance()));
  assert.doesNotThrow(() =>
    assertValidProvenance({
      producedBy: 'provider',
      reproducibility: 'deterministic',
      note: null
    })
  );
});

test('provenance: импорт нельзя объявить воспроизводимым', () => {
  assert.throws(
    () =>
      assertValidProvenance({
        producedBy: 'import',
        reproducibility: 'deterministic',
        note: null
      }),
    InvariantError
  );

  assert.throws(
    () =>
      assertValidProvenance({
        producedBy: 'import',
        reproducibility: 'stochastic',
        note: null
      }),
    InvariantError
  );
});

test('provenance: ручная работа не бывает воспроизводимой', () => {
  assert.throws(
    () =>
      assertValidProvenance({
        producedBy: 'human',
        reproducibility: 'deterministic',
        note: null
      }),
    InvariantError
  );
});

test('provenance: неизвестные значения отклоняются', () => {
  assert.throws(
    () =>
      assertValidProvenance({
        // @ts-expect-error намеренно невалидное значение
        producedBy: 'magic',
        reproducibility: 'unknown',
        note: null
      }),
    InvariantError
  );

  assert.throws(
    () =>
      assertValidProvenance({
        producedBy: 'provider',
        // @ts-expect-error намеренно невалидное значение
        reproducibility: 'probably',
        note: null
      }),
    InvariantError
  );
});
