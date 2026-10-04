// Plugin rule kinds execute through the real host, matcher and lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_MIN, MS_PER_HOUR } from '@shared/units';
import { join } from 'node:path';
import { parseRuleSpec } from '@shared/ruleSpec';
import { RuleSchedule } from '../src/core/rules/schedule';
import { settleAsync, tempDir } from './helpers';
import { includeProbe, probeAction, probeInput, startProbe } from './pluginRuleProbe';
/** Maximum run rows inspected in each probe assertion. */
const RUN_LIMIT = 10;

let remove: () => void;
let h: ReturnType<typeof startProbe>;
beforeEach(() => {
  remove = includeProbe();
  h = startProbe();
});
afterEach(async () => {
  await h.host.setEnabled('ruleprobe', false);
  remove();
});
describe('plugin rule kinds', () => {
  it('fires accepted trigger rules once per key, passes gates and direct filters, and settles event ids', async () => {
    const id = h.rules.create(probeInput({
      trigger: {
        type: 'ruleprobe.start',
        config: 'yes',
      },
      match: [{
        type: 'ruleprobe.direct',
        config: 'hit',
      }],
      narrow: [{
        type: 'ruleprobe.filter',
        config: 1,
      }],
    }));
    const m = h.message();
    h.fire(m, 'rejected', false);
    h.fire(h.message('miss'), 'not-matched');
    h.fire(m, 'one');
    h.fire(m, 'one');
    expect(h.rules.runs(id, RUN_LIMIT)).toHaveLength(1);
    expect(h.state.prepares).toBe(1);
    expect(h.settled).toHaveLength(4);
    expect(new Set(h.settled.map((e) => e.eventId)).size).toBe(4);
    expect(h.settled.every((e) => e.answers === null)).toBe(true);
    expect(h.runs[0]?.event).toMatchObject({
      eventId: h.settled[2]?.eventId,
    });
    const input = probeInput({
      trigger: {
        type: 'ruleprobe.start',
        config: 'yes',
      },
    });
    input.spec.gates.channelIds = ['elsewhere'];
    h.rules.update(id, input);
    h.fire(m, 'gated');
    expect(h.rules.runs(id, RUN_LIMIT)).toHaveLength(1);
    await settleAsync();
  });
  it('refuses synchronous and asynchronous triggers fired inside actions', async () => {
    const id = h.rules.create(probeInput({
      trigger: {
        type: 'ruleprobe.start',
        config: 'yes',
      },
      actions: [probeAction(), probeAction('after')],
    }));
    h.state.nested = true;
    h.fire(h.message(), 'outer');
    await settleAsync();
    expect(h.rules.runs(id, RUN_LIMIT)).toHaveLength(1);
    expect(h.runs.map((run) => run.actionId)).toEqual(['instant', 'after']);
    expect(h.settled).toHaveLength(1);
  });
  it('matches directly or asks Jev, including mayAct and answers on settlement', async () => {
    const id = h.rules.create(probeInput({
      match: [{
        type: 'ruleprobe.direct',
        config: 'hit',
      }, {
        type: 'ruleprobe.question',
        config: 'Match?',
      }],
    }));
    h.check(h.message());
    expect(h.mayAct).toEqual([true]);
    h.check(h.message('ask instead'));
    await settleAsync();
    expect(h.mayAct).toEqual([true, true]);
    expect(h.rules.runs(id, RUN_LIMIT)).toHaveLength(2);
    expect(h.settled.some((event) => event.answers?.probe)).toBe(true);
    expect(h.runs.map((run) => run.event.kind === 'message' && run.event.hit.kind)).toEqual(['pattern', 'meaning']);
  });
  it('records phase order, interval skips, history and the existing run services', async () => {
    const id = h.rules.create(probeInput({
      actions: [probeAction('after'), probeAction()],
    }));
    const first = h.message();
    h.check(first);
    await settleAsync();
    expect(h.runs.map((run) => run.actionId)).toEqual(['instant', 'after']);
    h.check(h.message());
    await settleAsync();
    expect(h.rules.runs(id, RUN_LIMIT)[0]?.actions.find((a) => a.actionId === 'after')?.outcome).toBe('skipped');
    expect(h.context().rules.attemptsSince('ruleprobe.after', 0)).toBe(1);
    expect(h.context().rules.lastDone(id, 'after')).not.toBeNull();
    const runId = h.runs[0]!.runId!;
    h.context().rules.update(runId, 'instant', 'ruleprobe.instant', {
      outcome: 'failed',
      detail: 'late report',
    });
    expect(h.rules.runs(id, RUN_LIMIT).find((run) => run.id === runId)?.actions[0]).toMatchObject({
      detail: 'late report',
    });
    const history = {
      ...first,
      ts: h.engine.find(id)!.armedAt - MS_PER_MIN,
    };
    h.check(history);
    expect(h.runs.at(-1)).toMatchObject({
      history: true,
      runId: null,
      actionId: 'instant',
    });
    expect(h.rules.runs(id, RUN_LIMIT)).toHaveLength(2);
  });
  it('namespaces managed keys, preserves owner edits, disables, re-arms and reports edits', () => {
    const sync = (enabled: boolean) => h.context().rules.managed.sync([{
      key: 'owned',
      enabled,
      input: () => probeInput(),
    }]);
    expect(sync(false)).toBe(false);
    expect(sync(true)).toBe(true);
    const rule = h.rules.list()[0]!;
    expect(rule.builtin).toBe('ruleprobe.owned');
    expect(h.context().rules.managed.key('owned')).toBe(rule.builtin);
    expect(h.context().rules.managed.ruleId('owned')).toBe(rule.id);
    expect(h.context().rules.managed.ruleId('other')).toBeNull();
    h.rules.update(rule.id, {
      ...probeInput(),
      name: 'Owner name',
    });
    expect(sync(false)).toBe(true);
    h.advance(MS_PER_MIN);
    expect(sync(true)).toBe(true);
    expect(h.rules.list()[0]).toMatchObject({
      name: 'Owner name',
      enabled: true,
      armedAt: rule.armedAt + MS_PER_MIN,
    });
    expect(() => h.rules.update(rule.id, probeInput({
      match: [{
        type: 'ruleprobe.direct',
        config: 'x',
      }],
    }))).toThrow(/keeps its trigger, match and narrowing/);
    h.rules.remove(rule.id);
    expect(h.edits.at(-1)).toEqual({
      ruleId: rule.id,
      deleted: true,
      matchChanged: false,
      spec: null,
    });
    expect(h.context().rules.managed.ruleId('owned')).toBeNull();
  });
  it('uses plugin coverage for app-start windows and removes it when disabled', async () => {
    const armedAt = h.rules.create(probeInput({
      trigger: {
        type: 'timed',
        config: {
          kind: 'appStart',
          awayHours: 1,
        },
      },
      actions: [probeAction('window')],
    }));
    const armed = h.engine.find(armedAt)!.armedAt;
    h.state.coverage = armed + MS_PER_MIN;
    const schedule = new RuleSchedule(h.db, h.engine, h.actions, armed, () => undefined, () => armed + 2 * MS_PER_HOUR);
    await schedule.tick();
    expect(h.runs[0]?.event).toMatchObject({
      kind: 'window',
      range: {
        sinceTs: h.state.coverage,
      },
    });
    await h.host.setEnabled('ruleprobe', false);
    expect(h.engine.kinds.windows.covered({ sinceTs: 0, channelIds: null })).toBeNull();
  });
  it('drops registrations while off, explains conditions, skips only unavailable actions, and restores on activation', async () => {
    const condition = h.rules.create(probeInput({
      match: [{
        type: 'ruleprobe.direct',
        config: 'hit',
      }],
    }));
    const action = h.rules.create(probeInput({
      // The host's file action stays available while the probe is off.
      actions: [probeAction(), { id: 'file', type: 'file', config: { path: join(tempDir(), 'hits.md'), format: 'markdown' } }],
    }));
    const old = h.context();
    await h.host.setEnabled('ruleprobe', false);
    expect(h.engine.find(condition)).toBeUndefined();
    expect(h.rules.list().find((r) => r.id === condition)?.error).toBe('Needs the Rule probe plugin, which is off.');
    h.check(h.message());
    // The file action's write is asynchronous: wait for its outcome.
    await vi.waitFor(() => expect(h.rules.runs(action, RUN_LIMIT)[0]?.actions.map((a) => a.outcome)).toEqual(['skipped', 'done']));
    expect(h.rules.runs(action, RUN_LIMIT)[0]?.actions[0]?.detail).toBe('Needs the Rule probe plugin, which is off.');
    expect(old.rules.managed.sync([{
      key: 'late',
      enabled: true,
      input: () => probeInput(),
    }])).toBe(false);
    old.rules.onSettled(() => {
      throw new Error('stale context');
    });
    expect(h.settled).toEqual([]);
    await h.host.setEnabled('ruleprobe', true);
    expect(h.engine.find(condition)).toBeDefined();
    h.check(h.message());
    expect(h.runs).toHaveLength(2);
  });
  it('keeps absent kinds editable, refuses their conditions and records their action skips', async () => {
    const input = probeInput({
      actions: [{
        id: 'gone',
        type: 'absent.act',
        config: {
          saved: true,
        },
      }, probeAction()],
    });
    const id = h.rules.create(input);
    expect(parseRuleSpec(JSON.stringify(input.spec))).toEqual(input.spec);
    h.rules.update(id, {
      ...input,
      name: 'Edited',
    });
    h.check(h.message());
    await settleAsync();
    expect(h.rules.runs(id, RUN_LIMIT)[0]?.actions).toContainEqual(expect.objectContaining({
      actionId: 'gone',
      outcome: 'skipped',
      detail: "Needs the absent plugin, which this ChattyPop doesn't include.",
    }));
    const missing = h.rules.create(probeInput({
      narrow: [{
        type: 'absent.filter',
        config: {},
      }],
    }));
    expect(h.engine.find(missing)).toBeUndefined();
    expect(h.rules.list().find((r) => r.id === missing)?.error).toContain("doesn't include");
  });
});
