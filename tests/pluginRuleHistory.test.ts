// Probe contracts for message-arrival callbacks and plugin-owned direct-history readers.
import { describe, expect, it, vi } from 'vitest';
import { AFTER_MESSAGE, defineRuleAction, definePlugin } from '@plugin-sdk/shared';
import { emptyRegistrations } from '../src/core/plugins/api';
import { pluginRules } from '../src/core/plugins/rules';
import { RuleKinds } from '../src/core/rules/kinds';
import type { TextMessage } from '../src/core/arrival';

/** A match-phase action that keeps history: the kind a direct-history reader serves. */
const record = defineRuleAction({
  ...AFTER_MESSAGE,
  type: 'probe.record',
  label: 'Record',
  hint: '',
  phase: 'match',
  history: true,
  create: () => null,
  validate() {},
});

describe('plugin rule history and arrival contracts', () => {
  it('guards readers and callbacks, enforces action ownership and becomes inert on unload', () => {
    const plugin = definePlugin({
      manifest: {
        id: 'probe',
        name: 'Probe',
        version: '1',
        description: '',
      },
      rules: { actions: [record] },
    });
    const kinds = new RuleKinds();
    const reg = emptyRegistrations();
    const failures: unknown[] = [];
    const history = { armedAt: 1, syncDirect: true, matches: () => [] };
    const read = vi.fn(() => history);
    kinds.bindHistory(read);
    const readRules = vi.fn(() => [{ id: 7, spec: null }]);
    const rules = pluginRules(plugin, kinds, reg, {
      lastDone: () => null,
      attemptsSince: () => 0,
      update: () => undefined,
    }, (fn) => {
      try {
        fn();
      } catch (error) {
        failures.push(error);
      }
    }, readRules);
    expect(rules.read()).toEqual([{ id: 7, spec: null }]);
    const seen: string[] = [];
    rules.onMessage((message) => { seen.push(message.id); });
    rules.onMessage(() => { throw new Error('probe failed'); });
    const message = { id: 'message' } as TextMessage;
    kinds.message(message);
    expect(seen).toEqual(['message']);
    expect(failures).toHaveLength(1);
    expect(rules.history('probe.record', 7)).toBe(history);
    expect(read).toHaveBeenCalledWith('probe.record', 7);
    expect(() => rules.history('foreign.record' as 'probe.record', 7)).toThrow(/declares none/);
    const readFailure = new Error('Rule storage failed');
    readRules.mockImplementationOnce(() => { throw readFailure; });
    expect(() => rules.read()).toThrow(readFailure);
    expect(failures.at(-1)).toBe(readFailure);
    reg.unloaded = true;
    expect(rules.read()).toEqual([]);
    expect(readRules).toHaveBeenCalledTimes(2);
    reg.disposers.forEach((dispose) => dispose());
    kinds.message(message);
    expect(seen).toEqual(['message']);
    expect(rules.history('probe.record', 7)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
