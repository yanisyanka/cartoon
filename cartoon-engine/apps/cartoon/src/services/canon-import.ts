/** Импорт правил канона из транскрипции CAST.md. */
import type { EngineDb } from '@core/index';
import { CANON_RULES } from '../domain/canon-rules';
import { upsertCanonRule, type CanonRuleView } from '../repositories/canon-rules';

export type CanonImportOutcome = {
  rule: CanonRuleView;
  status: 'created' | 'updated' | 'unchanged';
};

export async function importCanonRules(db: EngineDb): Promise<CanonImportOutcome[]> {
  const outcomes: CanonImportOutcome[] = [];

  for (const spec of CANON_RULES) {
    const { rule, created, updated } = await upsertCanonRule(db, spec);
    outcomes.push({
      rule,
      status: created ? 'created' : updated ? 'updated' : 'unchanged'
    });
  }

  return outcomes;
}
