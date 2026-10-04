// Contract tests for rule ranges, through the host's plugin-command action.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTION_LOOKBACK_MS, type RuleAction } from '@shared/rules';
import { newRuleAction } from '@shared/ruleSpec';
import { RULE_DETAIL_MAX_CHARS } from '../src/core/rules/hostActions';
import { ARRIVAL } from '../src/core/arrival';
import { ruleHarness, ruleInput, runsOf, type Harness } from './ruleHarness';

let h: Harness;
beforeEach(() => {
  h = ruleHarness();
});

const plugin = (): RuleAction =>
  ({
    ...newRuleAction('command'),
    config: { pluginId: 'p', commandId: 'c', lookbackMs: DEFAULT_ACTION_LOOKBACK_MS },
  }) as RuleAction;
/** Each run's outcome details, oldest first, once `count` runs have recorded their one action. */
async function settled(id: number, count: number): Promise<(string | null)[]> {
  await vi.waitFor(() => expect(h.rules.runs(id, 100).filter((r) => r.actions.length === 1)).toHaveLength(count));
  return h.rules
    .runs(id, 100)
    .reverse()
    .map((r) => r.actions[0]!.detail);
}

describe('rule plugin-command action', () => {
  it("runs over the message's channel for the time before it, then waits out its floor", async () => {
    const id = h.rules.create(ruleInput([plugin()]));
    const m = h.say('big news');
    await settled(id, 1);
    h.say('more news');
    const details = await settled(id, 2);
    const ts = h.db.prepare('SELECT ts FROM messages WHERE id = ?').pluck().get(m.id) as number;
    expect(h.ranges.commands.map((c) => c.range)).toEqual([
      { sinceTs: ts - DEFAULT_ACTION_LOOKBACK_MS, untilTs: ts, channelIds: ['c1'] },
    ]);
    expect(details[0]).toBe('answered');
    expect(details[1]).toMatch(/at most once per minute/);
    expect(runsOf(h, id).map((r) => r[2])).toEqual([['done'], ['skipped']]);
  });

  it('skips while an earlier run of the same action is still going', async () => {
    let finish!: (s: string) => void;
    h.ranges.answer = () => new Promise((resolve) => (finish = resolve));
    const id = h.rules.create(ruleInput([plugin()]));
    h.say('one');
    h.say('two');
    await vi.waitFor(() => expect(runsOf(h, id)[1]?.[2]).toEqual(['skipped']));
    finish('x'.repeat(RULE_DETAIL_MAX_CHARS + 1));
    const details = await settled(id, 2);
    expect(details[0]).toBe(`${'x'.repeat(RULE_DETAIL_MAX_CHARS)}…`);
    expect(details[1]).toMatch(/still running/);
    expect(h.ranges.commands.map((c) => [c.pluginId, c.commandId, c.range.channelIds])).toEqual([['p', 'c', ['c1']]]);
  });

  it("doesn't run on a missed message by default; a failure is recorded", async () => {
    const id = h.rules.create(ruleInput([plugin()]));
    h.say('fetched', { via: ARRIVAL.sync }); // no action runs on backfill: the rule doesn't fire at all
    h.ranges.answer = () => Promise.reject(new Error('plugin broke'));
    const live = h.say('live');
    expect(await settled(id, 1)).toEqual(['plugin broke']);
    expect(runsOf(h, id)).toEqual([[live.id, true, ['failed']]]);
    expect(h.ranges.commands).toHaveLength(1);
  });
});
