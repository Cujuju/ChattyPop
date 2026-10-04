// Failed plugin rule hooks never interrupt other rules or retain disposed callbacks.
import { MS_PER_MIN } from '@shared/units';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { includeProbe, probeAction, probeInput, startProbe } from './pluginRuleProbe';
import { settleAsync } from './helpers';
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
describe('rule hook isolation', () => {
  it('rejects a promise from a match action at runtime and records the plugin failure', async () => {
    h.context().rules.action('ruleprobe.instant', (() => Promise.resolve({
      outcome: 'done',
      detail: null,
    })) as never);
    const id = h.rules.create(probeInput());
    h.check(h.message());
    await settleAsync();
    expect(h.rules.runs(id, RUN_LIMIT)[0]?.actions[0]).toMatchObject({
      outcome: 'failed',
      detail: 'A match-phase action must finish synchronously.',
    });
    expect(h.host.list()[0]?.error).toBe('A match-phase action must finish synchronously.');
  });

  it('drops trigger and filter registrations as well as match implementations', async () => {
    const trigger = h.rules.create(probeInput({ trigger: { type: 'ruleprobe.start', config: 'yes' } }));
    const filter = h.rules.create(probeInput({ narrow: [{ type: 'ruleprobe.filter', config: 1 }] }));
    await h.host.setEnabled('ruleprobe', false);
    expect(h.engine.find(trigger)).toBeUndefined();
    expect(h.engine.find(filter)).toBeUndefined();
    expect(h.engine.kinds.unavailable('triggers', 'ruleprobe.start')).toContain('which is off');
    expect(h.engine.kinds.unavailable('filters', 'ruleprobe.filter')).toContain('which is off');
    h.fire(h.message(), 'stale');
    expect(h.runs).toEqual([]);
    await h.host.setEnabled('ruleprobe', true);
    expect(h.engine.find(trigger)).toBeDefined();
    expect(h.engine.find(filter)).toBeDefined();
  });

  it('reports a changed match separately from action-only edits', () => {
    const input = probeInput();
    const id = h.rules.create(input);
    h.rules.update(id, { ...input, spec: { ...input.spec, actions: [probeAction('window')] } });
    expect(h.edits.at(-1)).toMatchObject({ ruleId: id, matchChanged: false, deleted: false });
    const edited = probeInput({ match: [{ type: 'ruleprobe.direct', config: 'new' }] });
    h.rules.update(id, edited);
    expect(h.edits.at(-1)).toEqual({ ruleId: id, matchChanged: true, deleted: false, spec: edited.spec });
  });

  it('blocks overlapping plugin actions and runs again after the interval', async () => {
    const id = h.rules.create(probeInput({ actions: [probeAction('after')] }));
    h.check(h.message());
    h.check(h.message());
    await settleAsync();
    const skipped = h.rules.runs(id, RUN_LIMIT).find((run) => run.actions[0]?.outcome === 'skipped');
    expect(skipped?.actions[0]?.detail).toContain('still running');
    h.advance(MS_PER_MIN);
    h.check(h.message());
    await settleAsync();
    expect(h.context().rules.attemptsSince('ruleprobe.after', 0)).toBe(2);
  });

  it.each(['match.prepare', 'filter.prepare'])('isolates %s and never throws during compilation', (hook) => {
    h.state.fail = hook;
    const id = h.rules.create(probeInput({
      match: [{
        type: 'ruleprobe.direct',
        config: 'hit',
      }],
      narrow: [{
        type: 'ruleprobe.filter',
        config: 1,
      }],
    }));
    expect(() => h.engine.reload()).not.toThrow();
    expect(h.engine.find(id)).toBeUndefined();
    expect(h.host.list()[0]?.error).toBe('hook failed');
    h.state.fail = '';
    h.engine.reload();
    expect(h.engine.find(id)).toBeDefined();
  });
  it.each(['direct', 'test', 'question', 'answer'])('isolates %s without stopping another rule', async (hook) => {
    const broken = h.rules.create(probeInput({
      match: [{
        type: hook === 'question' || hook === 'answer' ? 'ruleprobe.question' : 'ruleprobe.direct',
        config: 'hit',
      }],
      narrow: [{
        type: 'ruleprobe.filter',
        config: 1,
      }],
    }));
    const other = h.rules.create(probeInput({
      actions: [probeAction('window')],
    }));
    h.state.fail = hook;
    expect(() => h.check(h.message())).not.toThrow();
    await settleAsync();
    expect(h.rules.runs(broken, RUN_LIMIT)).toHaveLength(0);
    expect(h.rules.runs(other, RUN_LIMIT)).toHaveLength(1);
    expect(h.host.list()[0]?.error).toBe('hook failed');
  });
  it.each(['action', 'after'])('records a failed %s and continues subsequent actions', async (hook) => {
    const id = h.rules.create(probeInput({
      actions: [probeAction(), probeAction('after'), probeAction('window')],
    }));
    h.state.fail = hook;
    h.check(h.message());
    await settleAsync();
    expect(h.rules.runs(id, RUN_LIMIT)[0]?.actions.map((a) => a.outcome)).toEqual(hook === 'action' ? ['failed', 'done', 'done'] : ['done', 'failed', 'done']);
    expect(h.host.list()[0]?.error).toBe('hook failed');
  });
  it.each(['settled', 'edited', 'coverage'])('isolates the %s listener and removes it on unload', async (hook) => {
    h.state.fail = hook;
    const id = h.rules.create(probeInput());
    expect(() => h.check(h.message())).not.toThrow();
    expect(() => h.engine.kinds.windows.covered({ sinceTs: 0, channelIds: null })).not.toThrow();
    expect(h.host.list()[0]?.error).toBe('hook failed');
    await h.host.setEnabled('ruleprobe', false);
    const count = h.edits.length;
    h.rules.remove(id);
    expect(h.edits).toHaveLength(count);
  });
  it('rejects undeclared and foreign types in every section', () => {
    const rules = h.context().rules;
    for (const type of ['undeclared', 'foreign.post']) {
      expect(() => rules.action(type as never, () => ({
        outcome: 'done',
        detail: null,
      }))).toThrow(/declares none/);
      expect(() => rules.match(type as never, {
        direct: () => null,
      })).toThrow(/declares none/);
      expect(() => rules.filter(type as never, {
        test: () => true,
      })).toThrow(/declares none/);
      expect(() => rules.trigger(type as never)).toThrow(/declares none/);
    }
  });
});
