// The kind declarations load whole whichever module is imported first: an import cycle through rules.ts once left
// undefined entries in the host's kind lists when host.ts was loaded before ruleKinds/index.ts.
import { describe, expect, it } from 'vitest';
import { probe } from './pluginRuleDescriptor';
import { BUNDLED_PLUGINS } from '../src/shared/bundledPlugins';
import { MESSAGE_TRIGGER } from '../src/shared/ruleKinds/host';
import { ruleKinds, type RuleSection } from '../src/shared/ruleKinds';
import { includeProbe } from './pluginRuleProbe';

// A build with one plugin: its declarations module is imported above before the registry.
includeProbe();

const SECTIONS: RuleSection[] = ['triggers', 'match', 'filters', 'actions'];

describe('rule kind declarations', () => {
  it('are all defined when a kind file is imported before the registry', () => {
    expect(MESSAGE_TRIGGER).toBe('message');
    expect(probe.rules.triggers[0].type).toBe('ruleprobe.start');
    expect(probe.rules.match[0].type).toBe('ruleprobe.direct');
    expect(probe.rules.filters[0].type).toBe('ruleprobe.filter');
    expect(probe.rules.actions[0].type).toBe('ruleprobe.instant');
    expect(BUNDLED_PLUGINS).toContain(probe);
    for (const plugin of BUNDLED_PLUGINS) {
      for (const section of SECTIONS) {
        for (const kind of plugin.rules?.[section] ?? []) {
          expect(ruleKinds(section)).toContain(kind);
          expect(kind.create).toBeTypeOf('function');
        }
      }
    }
    for (const section of SECTIONS) for (const k of ruleKinds(section)) expect(k?.type).toEqual(expect.any(String));
  });
});
