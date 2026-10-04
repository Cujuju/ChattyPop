// Rule handlers: storage, the engine's reload, Alert history, Jev re-asks and the change events, kept together
// so every path does all of them.
import type { AppEvent } from '@shared/contract';
import { ruleSubject, type Rule, type RuleInput, type RuleRun } from '@shared/rules';
import type { Db } from '../db';
import { syncManagedRules } from './managed';
import type { RuleEngine } from './engine';
import type { RuleMatcher } from './matcher';
import { deleteRule, insertRule, listRules, managedRuleId, ruleRuns, storedSpec, updateRule } from './ruleStore';

/** Stores rule edits, recompiles rules and synchronizes dependent state. */
export class RuleService {
  constructor(
    private readonly db: Db,
    private readonly emit: (e: AppEvent) => void,
    private readonly engine: RuleEngine,
    private readonly matcher: RuleMatcher,
    private readonly now: () => number = Date.now,
  ) {
    engine.kinds.bindManaged({
      sync: (list) => {
        const changed = syncManagedRules(db, list, now());
        if (changed.length) {
          this.changed();
          for (const ruleId of changed) this.edited(ruleId, false);
          matcher.requestCatchUp();
        }
        return changed.length > 0;
      },
      ruleId: (key) => managedRuleId(db, key),
    });
  }

  /** Tells rule-kind owners a stored rule changed, with its spec after the edit. */
  private edited(ruleId: number, matchChanged: boolean): void {
    this.engine.kinds.edited({ ruleId, matchChanged, deleted: false, spec: storedSpec(this.db, ruleId) });
  }

  private changed(): void {
    this.engine.reload();
    this.emit({ type: 'rules-changed' });
  }

  /** After a rule's match may have changed: its history over the archive, and the lookback window asked again. */
  private rematch(id: number, jevChanged: boolean): void {
    if (jevChanged) this.matcher.forget(ruleSubject(id)); // answers to the old question no longer apply
    this.matcher.catchUpJudgments();
  }

  list(): Rule[] {
    return listRules(this.db).map((rule) => ({
      ...rule,
      error: rule.error ?? this.engine.kinds.unavailableRule(rule.spec),
    }));
  }

  create(input: RuleInput): number {
    const id = insertRule(this.db, input, this.now());
    this.changed();
    this.edited(id, false);
    this.rematch(id, false);
    return id;
  }

  update(id: number, input: RuleInput): void {
    const { jevChanged, matchChanged } = updateRule(this.db, id, input, this.now());
    this.changed();
    this.edited(id, matchChanged);
    this.rematch(id, jevChanged);
  }

  remove(id: number): void {
    deleteRule(this.db, id);
    this.engine.kinds.edited({ ruleId: id, matchChanged: false, deleted: true, spec: null }); // its runs and plugin rows cascade
    this.matcher.forget(ruleSubject(id));
    this.changed();
  }


  runs(ruleId: number, limit: number): RuleRun[] {
    return ruleRuns(this.db, ruleId, limit);
  }

}
