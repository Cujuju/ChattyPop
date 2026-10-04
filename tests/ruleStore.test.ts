import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { RULE_SPEC_VERSION, type RuleInput } from '@shared/rules';
import type { Db } from '../src/core/db';
import { setSetting } from '../src/core/db';
import type { RuleService } from '../src/core/rules/ruleService';
import { claimRun, recordOutcome } from '../src/core/rules/ruleStore';
import { ruleHarness } from './ruleHarness';
import { probeInput } from './pluginRuleProbe';

let db: Db;
let events: AppEvent[];
let clock: number;
let rules: RuleService;
beforeEach(() => {
  clock = 1_000;
  ({ db, events, rules } = ruleHarness(() => clock));
});

const rule = (over: Partial<RuleInput> = {}): RuleInput => ({ ...probeInput(), name: 'R', ...over });

describe('rule store', () => {
  it('stores rules in run order, armed when created, and says when they change', () => {
    const a = rules.create(rule({ name: 'a' }));
    clock = 2_000;
    const b = rules.create(rule({ name: 'b' }));
    expect(rules.list().map((r) => [r.id, r.name, r.armedAt, r.fired])).toEqual([
      [a, 'a', 1_000, 0],
      [b, 'b', 2_000, 0],
    ]);
    expect(events.filter((e) => e.type === 'rules-changed')).toHaveLength(2);
  });

  it('re-arms a rule only when it is turned back on', () => {
    const id = rules.create(rule());
    clock = 2_000;
    rules.update(id, rule({ name: 'renamed' }));
    expect(rules.list()[0]!.armedAt).toBe(1_000);
    rules.update(id, rule({ enabled: false }));
    clock = 3_000;
    rules.update(id, rule({ enabled: true }));
    expect(rules.list()[0]!.armedAt).toBe(3_000);
  });

  it('claims an event for a rule once; deleting the rule drops its runs', () => {
    const id = rules.create(rule());
    const m = { id: 'm1', channelId: 'c1' };
    const run = claimRun(db, id, 'msg:m1', m, true, clock)!;
    expect(claimRun(db, id, 'msg:m1', m, true, clock)).toBeNull();
    recordOutcome(db, run, 'x', 'notify', 'done', null, clock);
    expect(rules.list()[0]!.fired).toBe(1);
    expect(rules.runs(id, 5)[0]!.actions).toEqual([{ actionId: 'x', kind: 'notify', outcome: 'done', detail: null }]);
    rules.remove(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rule_runs').get()).toEqual({ n: 0 });
  });

  it('lists a rule saved by a newer version with the reason it cannot run', () => {
    const id = rules.create(rule());
    db.prepare('UPDATE rules SET spec = ? WHERE id = ?').run(JSON.stringify({ ...rule().spec, v: RULE_SPEC_VERSION + 1 }), id);
    expect(rules.list()[0]!.error).toMatch(/newer ChattyPop/);
  });

  it('hides runs about channels privacy mode hides', () => {
    const id = rules.create(rule());
    claimRun(db, id, 'msg:a', { id: 'a', channelId: 'c1' }, true, clock);
    claimRun(db, id, 'msg:b', { id: 'b', channelId: 'c2' }, true, clock);
    db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run('c2');
    setSetting(db, 'privacyMode', true);
    expect(rules.runs(id, 5).map((r) => r.channelId)).toEqual(['c1']);
  });
});
