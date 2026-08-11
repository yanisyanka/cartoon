/** Доступ к правилам канона. */
import type { EngineDb } from '@core/index';
import type { CanonRuleSpec, CanonSeverity } from '../domain/canon-rules';

export type CanonRuleView = {
  id: string;
  code: string;
  description: string;
  severity: CanonSeverity;
  enabled: boolean;
  source: string;
};

type CanonRuleRow = {
  id: string;
  code: string;
  description: string;
  severity: string;
  enabled: boolean;
  source: string;
};

export function toCanonRuleView(row: CanonRuleRow): CanonRuleView {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    severity: row.severity as CanonSeverity,
    enabled: row.enabled,
    source: row.source
  };
}

/**
 * Завести или обновить правило по коду.
 *
 * `enabled` при обновлении НЕ трогается: включённость — это решение человека о
 * том, применять ли правило сейчас, а транскрипция формулировки к этому решению
 * отношения не имеет. Переимпорт текста не должен молча включать выключенное.
 */
export async function upsertCanonRule(
  db: EngineDb,
  spec: CanonRuleSpec
): Promise<{ rule: CanonRuleView; created: boolean; updated: boolean }> {
  const existing = await db.canonRule.findUnique({ where: { code: spec.code } });

  if (!existing) {
    const row = await db.canonRule.create({
      data: {
        code: spec.code,
        description: spec.description,
        severity: spec.severity,
        source: spec.source
      }
    });
    return { rule: toCanonRuleView(row), created: true, updated: false };
  }

  const unchanged =
    existing.description === spec.description &&
    existing.severity === spec.severity &&
    existing.source === spec.source;

  if (unchanged) {
    return { rule: toCanonRuleView(existing), created: false, updated: false };
  }

  const row = await db.canonRule.update({
    where: { code: spec.code },
    data: {
      description: spec.description,
      severity: spec.severity,
      source: spec.source
    }
  });
  return { rule: toCanonRuleView(row), created: false, updated: true };
}

export async function listCanonRules(db: EngineDb): Promise<CanonRuleView[]> {
  const rows = await db.canonRule.findMany({ orderBy: { code: 'asc' } });
  return rows.map(toCanonRuleView);
}

export async function countCanonRules(db: EngineDb): Promise<number> {
  return db.canonRule.count();
}
