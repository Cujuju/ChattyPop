// Synchronization of managed rule switches without replacing owner edits.
import type { RuleInput } from '@shared/rules';
import type { Db } from '../db';
import { insertRule } from './ruleStore';

/** A stable stored key and settings-driven switch; the owner retains editable rule fields. */
export interface ManagedRule {
  key: string;
  enabled: boolean;
  input(): RuleInput;
}

/** Creates, enables or disables managed rules without discarding alerts; returns only the ids of changed rows. */
export function syncManagedRules(db: Db, list: ManagedRule[], now: number): number[] {
  const changed: number[] = [];
  for (const rule of list) {
    const row = db.prepare('SELECT id, enabled FROM rules WHERE builtin = ?').get(rule.key) as
      { id: number; enabled: number } | undefined;
    const on = rule.enabled ? 1 : 0;
    if (row?.enabled === on || (!row && !on)) continue;
    // Back on: arm now so the rule never acts on messages that arrived while it was off.
    if (row) {
      db.prepare('UPDATE rules SET enabled = ?, armed_at = CASE WHEN ? = 1 THEN ? ELSE armed_at END WHERE id = ?').run(
        on,
        on,
        now,
        row.id,
      );
      changed.push(row.id);
    } else {
      changed.push(insertRule(db, { ...rule.input(), enabled: rule.enabled }, now, rule.key));
    }
  }
  return changed;
}
