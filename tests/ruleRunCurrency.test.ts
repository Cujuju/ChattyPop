// A run in progress follows its rule as it is now: deleting or turning it off stops further actions and due windows,
// a removed action never starts, and each action gets the rule's current settings.
import { describe, expect, it } from 'vitest';
import { newRuleAction } from '@shared/ruleSpec';
import type { RuleInput } from '@shared/rules';
import { MS_PER_HOUR } from '@shared/units';
import type { ActionRun } from '../src/core/rules/kinds';
import { claimRun } from '../src/core/rules/ruleStore';
import { RuleSchedule } from '../src/core/rules/schedule';
import { settleAsync } from './helpers';
import { ruleHarness, ruleInput, type Harness } from './ruleHarness';

const command = (id: string) => ({ ...newRuleAction('command', id), config: { pluginId: 'p', commandId: 'c', lookbackMs: MS_PER_HOUR } });
const done = { outcome: 'done' as const, detail: null };

/** Records each command action's start; the first waits for `release`. */
function holdFirst(h: Harness) {
  const started: ActionRun[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.engine.kinds.action('command', async (_, run) => {
    started.push(run);
    if (started.length === 1) await held;
    return done;
  });
  return { started, release };
}

describe('a message rule changed while its run waits on an action', () => {
  const input = (): RuleInput => ruleInput([command('first'), command('second')], { discordSend: true });

  for (const [change, edit] of [
    ['deleted', (h: Harness, id: number) => h.rules.remove(id)],
    ['turned off', (h: Harness, id: number) => h.rules.update(id, { ...input(), enabled: false })],
    ['loses the later action', (h: Harness, id: number) => h.rules.update(id, { ...input(), spec: { ...input().spec, actions: [command('first')] } })],
  ] as const) {
    it(`starts no further action when ${change}`, async () => {
      const h = ruleHarness();
      const { started, release } = holdFirst(h);
      const id = h.rules.create(input());
      h.say('news');
      await settleAsync();
      expect(started.map((r) => r.actionId)).toEqual(['first']);
      edit(h, id);
      release();
      await settleAsync();
      expect(started.map((r) => r.actionId)).toEqual(['first']);
    });
  }

  it('runs the next action with the rule as it is now', async () => {
    const h = ruleHarness();
    const { started, release } = holdFirst(h);
    const id = h.rules.create(input());
    h.say('news');
    await settleAsync();
    h.rules.update(id, { ...input(), discordSend: false });
    release();
    await settleAsync();
    expect(started.map((r) => [r.actionId, r.rule.discordSend])).toEqual([['first', true], ['second', false]]);
  });
});

describe('a timed rule changed while it catches up missed windows', () => {
  const hourly = (): RuleInput => ruleInput([command('range')], { trigger: { kind: 'every', hours: 1, backfillHours: 24 } });

  for (const [change, edit] of [
    ['deleted', (h: Harness, id: number) => h.rules.remove(id)],
    ['turned off', (h: Harness, id: number) => h.rules.update(id, { ...hourly(), enabled: false })],
  ] as const) {
    it(`claims and runs no further window when ${change}`, async () => {
      let now = Date.now();
      const h = ruleHarness(() => now);
      const { started, release } = holdFirst(h);
      const id = h.rules.create(hourly());
      const schedule = new RuleSchedule(h.db, h.engine, h.actions, now, () => undefined, () => now);
      now += 3 * MS_PER_HOUR; // three due times missed
      const tick = schedule.tick();
      await settleAsync();
      expect(started).toHaveLength(1);
      edit(h, id);
      release();
      await tick;
      expect(started).toHaveLength(1);
      expect(h.db.prepare('SELECT COUNT(*) FROM rule_runs WHERE rule_id = ?').pluck().get(id)).toBeLessThanOrEqual(1);
    });
  }

  it('a turned-off rule claims no run', () => {
    const h = ruleHarness();
    const id = h.rules.create(hourly());
    h.rules.update(id, { ...hourly(), enabled: false });
    expect(claimRun(h.db, id, 'time:every:1', null, true, Date.now())).toBeNull();
  });
});
