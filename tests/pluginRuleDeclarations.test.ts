// Descriptor namespace, ownership and config inference contracts for rule kinds.
import { describe, expect, it } from 'vitest';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { checkBundled } from '@shared/bundledCheck';
import { defineRuleFilter, defineRuleTrigger, defineRuleMatch, defineRuleAction, AFTER_MESSAGE } from '@plugin-sdk/shared';
import { probe } from './pluginRuleDescriptor';
const base = {
  label: '',
  hint: '',
  create: () => null,
  validate() {},
};
const plugin = (rules: PluginDescriptor['rules']): PluginDescriptor => ({
  manifest: probe.manifest,
  rules,
});
describe('plugin rule declarations', () => {
  it('accepts all four sections and rejects unqualified, foreign and empty kind names', () => {
    expect(() => checkBundled([probe])).not.toThrow();
    for (const type of ['text', 'other.match', 'ruleprobe.', 'ruleprobe.a.b']) {
      expect(() => checkBundled([plugin({
        filters: [defineRuleFilter({
          ...base,
          type,
        })],
      })])).toThrow(/must be/);
    }
  });
  it('rejects duplicates across sections and collisions with bundled kinds', () => {
    const type = 'ruleprobe.same';
    expect(() => checkBundled([plugin({
      triggers: [defineRuleTrigger({
        ...base,
        type,
        event: 'message',
      })],
      match: [defineRuleMatch({
        ...base,
        type,
        asksJev: false,
      })],
    })])).toThrow(/Two bundled plugins provide rule kind/);
    expect(() => checkBundled([probe, {
      manifest: probe.manifest,
      rules: {
        actions: [defineRuleAction({
          ...base,
          ...AFTER_MESSAGE,
          type: 'ruleprobe.instant',
        })],
      },
    }])).toThrow(/Two bundled plugins/);
    expect(() => checkBundled([probe, probe])).toThrow(/Two bundled plugins/);
  });
  it('refuses plugin window triggers in R2', () => {
    expect(() => checkBundled([plugin({
      triggers: [defineRuleTrigger({
        ...base,
        type: 'ruleprobe.window',
        event: 'window',
      })],
    })])).toThrow(/must use event: message/);
  });
});
