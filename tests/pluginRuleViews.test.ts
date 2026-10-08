// Renderer rule contributions remain editable while off and publish badges only while active.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';
import { ruleSlots } from '../src/renderer/src/plugins/ruleSlots';
const state = {
  on: true,
};
const view = {
  Editor: () => null,
  summary: (config: unknown) => String(config),
};
const {
  view: pluginKindView,
  offered: kindOffered,
  badges: ruleBadges
} = ruleSlots(() => [{
  plugin: {
    manifest: {
      id: 'probe',
    },
  },
  contributions: {
    rules: {
      triggers: {
        'probe.trigger': view,
      },
      match: {
        'probe.match': view,
      },
      filters: {
        'probe.filter': {
          ...view,
          chips: (config: unknown) => [String(config)],
        },
      },
      actions: {
        'probe.action': view,
      },
      ruleBadge: (rule: Rule) => rule.id === 1 ? 'probe badge' : null,
    },
  },
}], () => state.on);
const rule: Rule = {
  ...newRuleInput(),
  id: 1,
  position: 0,
  armedAt: 0,
  createdAt: 0,
  builtin: null,
  group: null,
  error: null,
  fired: 0,
  lastFiredAt: null,
};
beforeEach(() => {
  state.on = true;
});
describe('plugin kind views', () => {
  it('finds each kind view while off, but does not offer the kind for a new part', () => {
    for (const [section, type] of [['triggers', 'probe.trigger'], ['match', 'probe.match'], ['filters', 'probe.filter'], ['actions', 'probe.action']] as const) {
      expect(pluginKindView(section, type)?.summary('saved')).toBe('saved');
      expect(kindOffered(type)).toBe(true);
      state.on = false;
      expect(pluginKindView(section, type)?.summary('saved')).toBe('saved');
      expect(kindOffered(type)).toBe(false);
      state.on = true;
    }
    expect(pluginKindView('actions', 'missing.action')).toBeUndefined();
  });
  it('passes the rule to its badge, omits null and drops the badge on disable', () => {
    expect(ruleBadges(rule)).toEqual(['probe badge']);
    expect(ruleBadges({
      ...rule,
      id: 2,
    })).toEqual([]);
    state.on = false;
    expect(ruleBadges(rule)).toEqual([]);
    state.on = true;
    expect(ruleBadges(rule)).toEqual(['probe badge']);
  });
});
