// Shared managed validation and draft defaults follow descriptor ownership, including adoption aliases.
import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { newRuleInput, validateRuleInput } from '@shared/ruleSpec';
import { AFTER_MESSAGE } from '@plugin-sdk/shared';
import { join } from 'node:path';
import { insertRule, updateRule } from '../src/core/rules/ruleStore';
import { tempDb, tempDir } from './helpers';

it('uses a probe default action and validates only its managed keys, retaining absent owners unchecked', () => {
  const validate = vi.fn((spec) => {
    if (spec.narrow.length) throw new Error('Probe keeps its narrowing');
  });
  const probe: PluginDescriptor = {
    manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
    adopts: { managedRules: { old_probe: 'fixed' } },
    managedRules: { fixed: validate },
    rules: { actions: [{
      ...AFTER_MESSAGE,
      type: 'probe.default',
      label: 'Probe',
      hint: '',
      create: () => null,
      validate() {},
      defaultForNewRule: true,
    }] },
  };
  const list = BUNDLED_PLUGINS as PluginDescriptor[];
  const previous = list.splice(0, list.length, probe);
  try {
    const input = { ...newRuleInput(), name: 'Probe' };
    expect(input.spec.actions.map((a) => a.type)).toEqual(['probe.default']);
    validateRuleInput(input, 'probe.fixed');
    validateRuleInput(input, 'old_probe');
    expect(validate).toHaveBeenCalledTimes(2);
    validateRuleInput(input, 'other.fixed');
    expect(validate).toHaveBeenCalledTimes(2);
    input.spec.narrow = [{ type: 'contains', config: ['link'] }];
    expect(() => validateRuleInput(input, 'probe.fixed')).toThrow('Probe keeps its narrowing');
    list.splice(0);
    expect(newRuleInput().spec.actions).toEqual([]);
    expect(() => validateRuleInput(input, 'probe.fixed')).not.toThrow();
  } finally {
    list.splice(0, list.length, ...previous);
  }
});

describe('managed store invariants', () => {
  it('preserves trigger, match and narrowing for any managed owner while allowing names and gates to change', () => {
    const db = tempDb();
    const base = newRuleInput();
    // A host action: the app has no plugin whose default action a new rule could take.
    const write = { id: 'file', type: 'file', config: { path: join(tempDir(), 'hits.md'), format: 'markdown' } };
    const input = { ...base, name: 'Managed', spec: { ...base.spec, actions: [write] } };
    const id = insertRule(db, input, 1, 'probe.fixed');
    for (const patch of [
      { trigger: { type: 'missing.trigger', config: null } },
      { match: [{ type: 'text', config: { pattern: 'word', spec: null } }] },
      { narrow: [{ type: 'contains', config: ['link'] }] },
    ]) {
      expect(() => updateRule(db, id, { ...input, spec: { ...input.spec, ...patch } }, 2)).toThrow(/managed rule keeps/);
    }
    expect(() => updateRule(db, id, { ...input, name: 'Edited', spec: { ...input.spec, gates: { ...input.spec.gates, channelIds: ['c1'] } } }, 2)).not.toThrow();
  });
});
