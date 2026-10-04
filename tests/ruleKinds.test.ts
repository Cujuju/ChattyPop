// Rule kind validation, dispatch, lifecycle and ordering contracts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ruleKind, type RuleActionKind } from '@shared/ruleKinds';
import { newRuleAction } from '@shared/ruleSpec';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import type { ActionRun, Settled } from '../src/core/rules/kinds';
import { ARRIVAL } from '../src/core/arrival';
import { registerMessageQuestion, unregisterMessageQuestion } from '../src/core/jev/messageQuestions';
import { settleAsync } from './helpers';
import { probeAction, ruleHarness, ruleInput } from './ruleHarness';

const file = () => ({ ...newRuleAction('file'), config: { path: 'C:/notes.md', format: 'markdown' } });
const command = () => ({
  ...newRuleAction('command'),
  config: { pluginId: 'p', commandId: 'c', lookbackMs: MS_PER_HOUR },
});
const done = { outcome: 'done' as const, detail: null };
/** The probe's match-phase action, which keeps history. */
const MATCH_ACTION = probeAction();
/** The probe's plugin trigger: starts a rule on a message. */
const PROBE_TRIGGER = 'ruleprobe.start';
const restore: (() => void)[] = [];
function flags(type: string, patch: Partial<RuleActionKind>): void {
  const kind = ruleKind('actions', type)!;
  const before = { ...kind };
  Object.assign(kind, patch);
  restore.push(() => Object.assign(kind, before));
}
afterEach(() => {
  restore.splice(0).forEach((f) => f());
  unregisterMessageQuestion('test:mayAct');
});

describe('core kind dispatch', () => {
  it('prepares each match and filter once per compilation', () => {
    const h = ruleHarness();
    const prepareMatch = vi.fn(() => /news/);
    const prepareFilter = vi.fn(() => new Set(['example.com']));
    h.engine.kinds.match('text', {
      prepare: prepareMatch,
      direct: (re, { m }) => (re.test(m.content) ? { kind: 'pattern', probability: null, highlight: re } : null),
    });
    h.engine.kinds.filter('linkDomains', { prepare: prepareFilter, test: (domains) => domains.has('example.com') });
    h.rules.create(
      ruleInput([MATCH_ACTION], {
        match: { text: { pattern: 'news', spec: null } },
        narrow: { linkDomains: ['example.com'] },
      }),
    );
    expect(prepareMatch).toHaveBeenCalledTimes(1);
    expect(prepareFilter).toHaveBeenCalledTimes(1);
    h.say('news one');
    h.say('news two');
    expect(prepareMatch).toHaveBeenCalledTimes(1);
    expect(prepareFilter).toHaveBeenCalledTimes(1);
  });
  it('runs match-phase actions synchronously before ordered after actions', async () => {
    const h = ruleHarness();
    const order: string[] = [];
    h.engine.kinds.action(MATCH_ACTION.type, () => {
      order.push('match');
      return done;
    });
    h.engine.kinds.action('command', async () => {
      order.push('first');
      return done;
    });
    h.engine.kinds.action('file', () => {
      order.push('second');
      return done;
    });
    const id = h.rules.create(ruleInput([command(), MATCH_ACTION, file()]));
    h.say('news');
    expect(order).toEqual(['match', 'first']);
    await vi.waitFor(() => expect(order).toEqual(['match', 'first', 'second']));
    expect(h.rules.runs(id, 1)[0]!.actions.map((a) => a.kind)).toEqual([MATCH_ACTION.type, 'command', 'file']);
  });
  it('runs only history actions for older messages, scoped without a run record', () => {
    flags('file', { history: true, phase: 'match' });
    const h = ruleHarness(() => Date.now() + MS_PER_HOUR);
    const seen: ActionRun[] = [];
    const after = vi.fn(() => done);
    h.engine.kinds.action('file', (_, r) => {
      seen.push(r);
      return done;
    });
    h.engine.kinds.action('command', after);
    const id = h.rules.create(ruleInput([file(), command()], { gates: { channelIds: ['c1'] } }));
    h.say('old', { via: ARRIVAL.sync });
    h.say('elsewhere', { channel: 'c2', via: ARRIVAL.sync });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      history: true,
      runId: null,
      rule: { id },
      event: { kind: 'message', live: false },
    });
    expect(after).not.toHaveBeenCalled();
    expect(h.rules.runs(id, 10)).toEqual([]);
  });
  it('reports actions that fired directly or are awaiting Jev through mayAct', () => {
    const h = ruleHarness();
    h.jev.on.topicMeaning = true;
    const seen: boolean[][] = [];
    registerMessageQuestion({
      subject: 'test:mayAct',
      feature: 'topicMeaning',
      question: (_, c) => {
        seen.push(['file', 'command', 'ruleprobe.after'].map((type) => c.mayAct(type)));
        return null;
      },
    });
    h.engine.kinds.action('file', () => done);
    h.rules.create(ruleInput([file()], { match: { text: { pattern: 'news', spec: null } } }));
    h.rules.create(ruleInput([command()], { match: { meaning: 'news' } }));
    h.say('news');
    expect(seen.at(-1)).toEqual([true, true, false]);
  });
  it('orders history phases and awaits each after action', async () => {
    flags('file', { history: true });
    flags('command', { history: true });
    const h = ruleHarness(() => Date.now() + MS_PER_HOUR);
    const order: string[] = [];
    let finish!: () => void;
    h.engine.kinds.action(
      'file',
      () =>
        new Promise<typeof done>((resolve) => {
          order.push('first');
          finish = () => resolve(done);
        }),
    );
    h.engine.kinds.action(MATCH_ACTION.type, () => {
      order.push('match');
      return done;
    });
    h.engine.kinds.action('command', () => {
      order.push('second');
      return done;
    });
    h.rules.create(ruleInput([file(), MATCH_ACTION, command()]));
    h.say('old', { via: ARRIVAL.sync });
    expect(order).toEqual(['match', 'first']);
    finish();
    await vi.waitFor(() => expect(order).toEqual(['match', 'first', 'second']));
  });
  it('uses the declared interval and running guard for any action', async () => {
    flags('file', { minIntervalMs: MS_PER_MIN });
    let now = Date.now();
    const h = ruleHarness(() => now);
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<typeof done>((resolve) => {
          finish = () => resolve(done);
        }),
    );
    h.engine.kinds.action('file', run);
    const id = h.rules.create(ruleInput([file()]));
    h.say('one');
    h.say('two');
    await vi.waitFor(() =>
      expect(h.rules.runs(id, 10).some((r) => r.actions[0]?.detail?.includes('still running'))).toBe(true),
    );
    finish();
    await vi.waitFor(() => expect(h.rules.runs(id, 10).some((r) => r.actions[0]?.outcome === 'done')).toBe(true));
    h.say('three');
    await vi.waitFor(() => expect(h.rules.runs(id, 1)[0]?.actions[0]?.detail).toMatch(/once per minute/));
    expect(run).toHaveBeenCalledTimes(1);
    now += MS_PER_MIN;
    h.say('four');
    expect(run).toHaveBeenCalledTimes(2);
    finish();
  });
  it('refuses triggers raised synchronously or asynchronously from an action', async () => {
    const h = ruleHarness();
    const onTrigger = ruleInput([MATCH_ACTION]);
    const target = h.rules.create({ ...onTrigger, spec: { ...onTrigger.spec, trigger: { type: PROBE_TRIGGER, config: 'yes' } } });
    h.engine.kinds.action('file', async (_, r) => {
      if (r.event.kind !== 'message') throw new Error('expected a message');
      const e = { m: r.event.m, liveAt: r.event.liveAt, key: 'nested', accepts: () => true };
      h.engine.kinds.trigger(PROBE_TRIGGER).fire(e);
      await Promise.resolve();
      h.engine.kinds.trigger(PROBE_TRIGGER).fire(e);
      return done;
    });
    const source = h.rules.create(ruleInput([file()]));
    h.say('news');
    await vi.waitFor(() => expect(h.rules.runs(source, 1)[0]?.actions).toHaveLength(1));
    expect(h.rules.runs(target, 10)).toEqual([]);
  });
  it('settles nested trigger events without releasing another event notification', async () => {
    const h = ruleHarness();
    h.jev.on.topicMeaning = true;
    h.jev.values = { 'test:mayAct': 1 };
    const settled: Settled[] = [];
    h.engine.kinds.onSettled((e) => settled.push(e));
    registerMessageQuestion({
      subject: 'test:mayAct',
      feature: 'topicMeaning',
      question: () => ({ type: 'noul', instructions: 'Is `message` news?', criteria: { true: 'Yes', false: 'No' } }),
      onAnswer: (m, _, liveAt) =>
        h.engine.kinds.trigger(PROBE_TRIGGER).fire({ m, liveAt, key: 'nested', accepts: () => true }),
    });
    h.rules.create(ruleInput([MATCH_ACTION], { match: { text: { pattern: 'news', spec: null } } }));
    h.say('news');
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    await settleAsync();
    expect(h.probe.runs).toHaveLength(1);
    const arrival = h.probe.runs[0]!.event.kind === 'message' ? h.probe.runs[0]!.event.eventId : null;
    // The nested trigger settles under its own event; the arrival settles once, with Jev's answers.
    expect(settled.map((e) => [e.eventId === arrival, e.answers !== null])).toEqual([
      [false, false],
      [true, true],
    ]);
  });
  it('settles with null when Jev fails or no question was asked', async () => {
    const h = ruleHarness();
    const settled = vi.fn();
    h.engine.kinds.onSettled(settled);
    h.say('without Jev');
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ answers: null }));
    settled.mockClear();
    h.jev.on.topicMeaning = true;
    h.jev.fail = true;
    h.rules.create(ruleInput([command()], { match: { meaning: 'news' } }));
    h.say('news');
    await vi.waitFor(() =>
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ m: expect.objectContaining({ content: 'news' }), answers: null }),
      ),
    );
  });

  it('synchronizes managed rules, preserves owner edits and re-arms when enabled again', () => {
    let now = Date.now();
    const h = ruleHarness(() => now);
    const input = () => ruleInput([file()], { match: { text: { pattern: 'news', spec: null } } });
    h.engine.kinds.managed.sync([{ key: 'host.test', enabled: true, input }]);
    const first = h.rules.list().find((r) => r.builtin === 'host.test')!;
    h.rules.update(first.id, { ...first, name: 'Mine' });
    expect(() => h.rules.update(first.id, { ...first, spec: { ...first.spec, match: [] } })).toThrow(/keeps its trigger, match and narrowing/);
    h.engine.kinds.managed.sync([{ key: 'host.test', enabled: false, input }]);
    now += MS_PER_MIN;
    h.engine.kinds.managed.sync([{ key: 'host.test', enabled: true, input }]);
    expect(h.rules.list().find((r) => r.id === first.id)).toMatchObject({ name: 'Mine', enabled: true, armedAt: now });
    expect(h.engine.find(first.id)).toBeDefined();
  });
  it('reports matching edits and deletion to registered owners', () => {
    const h = ruleHarness();
    const listener = vi.fn();
    h.engine.kinds.onEdited(listener);
    const input = ruleInput([file()], { match: { text: { pattern: 'news', spec: null } } });
    const id = h.rules.create(input);
    listener.mockClear();
    h.rules.update(id, { ...input, name: 'Renamed' });
    expect(listener).toHaveBeenLastCalledWith({ ruleId: id, matchChanged: false, deleted: false, spec: input.spec });
    const sale = { ...input.spec, match: [{ type: 'text', config: { pattern: 'sale', spec: null } }] };
    h.rules.update(id, { ...input, spec: sale });
    expect(listener).toHaveBeenLastCalledWith({ ruleId: id, matchChanged: true, deleted: false, spec: sale });
    h.rules.remove(id);
    expect(listener).toHaveBeenLastCalledWith({ ruleId: id, matchChanged: false, deleted: true, spec: null });
  });
  it('reports only changed managed rows and emits nothing for an unchanged sync', () => {
    const h = ruleHarness();
    const listener = vi.fn();
    h.engine.kinds.onEdited(listener);
    const input = () => ruleInput([file()]);
    const first = { key: 'host.first', enabled: true, input };
    const second = { key: 'host.second', enabled: true, input };
    h.engine.kinds.managed.sync([first, second]);
    expect(listener).toHaveBeenCalledTimes(2);
    listener.mockClear();
    expect(h.engine.kinds.managed.sync([first, second])).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(h.engine.kinds.managed.sync([first, { ...second, enabled: false }])).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: h.rules.list().find((r) => r.builtin === second.key)!.id,
      matchChanged: false,
      deleted: false,
    }));
  });
});
