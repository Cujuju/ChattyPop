// Plugin state across off/on: held contexts of an unloaded plugin, parked settings, and the rule kind registries.
import { expect, it, onTestFinished } from 'vitest';
import { definePlugin, definePreference, isObj } from '@plugin-sdk/shared';
import { getSetting, setSetting } from '../src/core/db';
import { parkSummarySettings } from '../src/core/laterMigrations';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { ruleKinds, ruleKind } from '@shared/ruleKinds';
import { includeProbe } from './pluginRuleProbe';
import { startReadProbe } from './pluginReadHarness';
import { tempDb } from './helpers';

/** Adopts the parked summary preferences (and any still in the AI settings) into its `settings`, as Summaries declares. */
const summaries = definePlugin({
  manifest: { id: 'summaries', name: 'Summaries', version: '1', description: '' },
  preferences: { settings: definePreference<{ skipObviousFiller?: unknown; jevRouting?: unknown }>({ default: {}, normalize: (v) => (isObj(v) ? v : {}) }) },
  adopts: {
    settingFields: [
      { key: 'legacy.summarySettings', field: 'skipObviousFiller', name: 'settings' },
      { key: 'legacy.summarySettings', field: 'jevRouting', name: 'settings' },
      { key: 'ai', field: 'skipObviousFiller', name: 'settings' },
      { key: 'ai', field: 'jevRouting', name: 'settings' },
    ],
  },
});

it('parks summary preferences across an absent-plugin settings save and adopts them once', () => {
  const db = tempDb();
  const prefs = { skipObviousFiller: true, jevRouting: { chosen: 'preserve exactly' } };
  setSetting(db, 'ai', { ...prefs, defaultProvider: 'codex' });
  parkSummarySettings(db);
  setSetting(db, 'ai', { defaultProvider: 'ollama' });
  parkSummarySettings(db);
  expect(getSetting(db, 'legacy.summarySettings')).toEqual(prefs);
  adoptBundledData(db, [summaries]);
  expect(getSetting(db, 'plugin.summaries.settings')).toMatchObject(prefs);
  adoptBundledData(db, [summaries]);
  expect(getSetting(db, 'plugin.summaries.settings')).toMatchObject(prefs);
});

// Providers a held context was handed are revoked with it: pluginLifetime and pluginProviders.
it('drops archive notifications from held unloaded contexts', async () => {
  const h = startReadProbe(() => undefined);
  const held = h.context();
  await h.host.setEnabled('readprobe', false);
  h.events.length = 0;
  held.archive.changed('c1');
  expect(h.events).toEqual([]);
});

it('reuses immutable ordered registries and indexed kind identities', () => {
  // A build with a plugin declaring kinds in every section, beside the host's.
  onTestFinished(includeProbe());
  for (const section of ['triggers', 'match', 'filters', 'actions'] as const) {
    const first = ruleKinds(section);
    expect(first.some((kind) => kind.type.startsWith('ruleprobe.'))).toBe(true);
    expect(ruleKinds(section)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    for (const kind of first) expect(ruleKind(section, kind.type)).toBe(kind);
  }
});
