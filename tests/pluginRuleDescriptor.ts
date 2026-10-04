// Declarations for the bundled rule-kind contract probe.
import { definePlugin, defineRuleTrigger, defineRuleMatch, defineRuleFilter, defineRuleAction, AFTER_MESSAGE } from '@plugin-sdk/shared';
import { MS_PER_MIN } from '@shared/units';

const base = {
  label: 'Probe',
  hint: '',
  validate() {},
};
/** Declarations used by the engine, descriptor checks and config inference tests. */
export const probe = definePlugin({
  manifest: {
    id: 'ruleprobe',
    name: 'Rule probe',
    version: '1',
    description: '',
  },
  rules: {
    triggers: [defineRuleTrigger({
      ...base,
      type: 'ruleprobe.start',
      event: 'message',
      create: () => 'yes',
    })],
    match: [defineRuleMatch({
      ...base,
      type: 'ruleprobe.direct',
      asksJev: false,
      create: () => 'hit',
    }), defineRuleMatch({
      ...base,
      type: 'ruleprobe.question',
      asksJev: true,
      create: () => 'Match?',
    })],
    filters: [defineRuleFilter({
      ...base,
      type: 'ruleprobe.filter',
      create: () => 1,
    })],
    actions: [defineRuleAction({
      ...base,
      ...AFTER_MESSAGE,
      type: 'ruleprobe.instant',
      phase: 'match',
      history: true,
      create: () => null,
    }), defineRuleAction({
      ...base,
      ...AFTER_MESSAGE,
      type: 'ruleprobe.after',
      minIntervalMs: MS_PER_MIN,
      create: () => null,
    }), defineRuleAction({
      ...base,
      ...AFTER_MESSAGE,
      type: 'ruleprobe.window',
      targets: ['message', 'window'],
      create: () => null,
    })],
  },
});
