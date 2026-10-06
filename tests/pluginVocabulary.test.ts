// Stamps plugin vocabulary as pluginId.local, validates uniqueness, adopts legacy keys, and retains keys for absent plugins.
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { checkBundled } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { aiSettingsFrom } from '@shared/aiProviders';
import { normalizeAiSettings } from '@shared/aiSettings';
import { adoptNoticeKinds, privacyScopedIn } from '@shared/notices';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting } from '../src/core/db';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { tempDb } from './helpers';
import { digest, inbox, labels, planner } from './p1Plugins';

/** Fixture plugins owning Jev switches and notice kinds stored before they were plugins. */
const OWNERS = [inbox, digest, labels, planner];
const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });

/** Settings → AI as a profile from before these features were plugins stored it: every switch unstamped. */
const LEGACY_AI = {
  defaultProvider: null,
  providers: {},
  jevConnection: 'openrouter',
  jev: {
    topicMeaning: true, catchUpBadges: false, ruleQuestions: false, keepImportant: true, messageTags: false,
    messageClasses: false, messageCheck: true, suggestChannels: false, pluginDecide: false,
    urgentToasts: true, dedupeAlerts: false, keyThemes: true, planDetection: true, customTags: true,
  },
};
const HOST_SWITCHES = ['topicMeaning', 'catchUpBadges', 'ruleQuestions', 'keepImportant', 'messageTags', 'messageClasses', 'messageCheck', 'suggestChannels', 'pluginDecide'];
/** Each plugin's legacy switches: its declared keys, adopted unchanged. */
const legacyOwned = OWNERS.flatMap((p) => (p.jev?.features ?? []).map((f) => ({ legacy: f.key, stamped: `${p.manifest.id}.${f.key}` })));

describe('pre-plugin Jev switches', () => {
  it('read the same after adoption, and adoption runs once', () => {
    const db = tempDb();
    setSetting(db, SETTINGS_KEYS.ai, LEGACY_AI);
    adoptBundledData(db, OWNERS);
    const once = getSetting(db, SETTINGS_KEYS.ai);
    adoptBundledData(db, OWNERS);
    expect(getSetting(db, SETTINGS_KEYS.ai)).toEqual(once);
    const jev = aiSettingsFrom(once).jev as Record<string, boolean | undefined>;
    expect(legacyOwned.length).toBeGreaterThan(0);
    for (const { legacy, stamped } of legacyOwned) {
      expect(jev[stamped], stamped).toBe(LEGACY_AI.jev[legacy as keyof typeof LEGACY_AI.jev]);
      expect(Object.hasOwn(jev, legacy), legacy).toBe(false);
    }
    for (const f of HOST_SWITCHES) expect(jev[f], f).toBe(LEGACY_AI.jev[f as keyof typeof LEGACY_AI.jev]);
  });

  it('keep the owner’s value over a default a save stored under the stamped key before adoption', () => {
    const db = tempDb();
    setSetting(db, SETTINGS_KEYS.ai, { ...LEGACY_AI, jev: { ...LEGACY_AI.jev, 'planner.planDetection': false } });
    adoptBundledData(db, [planner]);
    expect(aiSettingsFrom(getSetting(db, SETTINGS_KEYS.ai)).jev['planner.planDetection']).toBe(true);
  });
});

describe('an absent owner’s switches', () => {
  it('survive normalizing and saving, adopted or not, and read as off', () => {
    const stored = { jev: { 'gone.probe': true, customTags: true, 'links.linkWorth': true, 'bad key': true, ruleQuestions: 'yes' } };
    const once = normalizeAiSettings(stored);
    const jev = normalizeAiSettings(JSON.parse(JSON.stringify(once))).jev as Record<string, unknown>;
    expect(jev).toMatchObject({ 'gone.probe': true, customTags: true, 'links.linkWorth': true, ruleQuestions: false });
    expect(Object.hasOwn(jev, 'bad key')).toBe(false);
  });

  it('take their declared default once the owner is installed', () => {
    const jev = normalizeAiSettings({}, [], [{ key: 'probe.on', default: true }, { key: 'probe.off', default: false }]).jev;
    expect(jev['probe.on']).toBe(true);
    expect(jev['probe.off']).toBe(false);
  });
});

describe('phones’ notice choices', () => {
  it('adopt pre-plugin kinds and keep kinds of absent owners; drop what is not a kind', () => {
    const stored = ['alert', 'plugin', 'summary', 'gone.kind', 'inbox.alert', 'bad kind', 3];
    expect(adoptNoticeKinds(OWNERS, stored)).toEqual(['inbox.alert', 'plugin', 'digest.summary', 'gone.kind']);
    expect(adoptNoticeKinds([], stored)).toEqual(['alert', 'plugin', 'summary', 'gone.kind', 'inbox.alert']);
  });

  it('are privacy-scoped as their declaration says, stamped', () => {
    expect(privacyScopedIn(OWNERS, 'inbox.alert')).toBe(true);
    expect(privacyScopedIn(OWNERS, 'digest.summary')).toBe(true);
    expect(privacyScopedIn(OWNERS, 'alert')).toBe(false);
    expect(privacyScopedIn(OWNERS, 'plugin')).toBe(false);
  });
});

describe('checkBundled over the installed descriptors', () => {
  it('accepts the owners', () => {
    expect(() => checkBundled(OWNERS)).not.toThrow();
  });

  it('rejects a stamped switch or notice kind declared twice', () => {
    const twice = definePlugin({ manifest: manifest('twice'), jev: { features: [{ key: 'a', default: false }, { key: 'a', default: true }] } });
    expect(() => checkBundled([twice])).toThrow(/Jev switch twice\.a/);
    const kinds = definePlugin({ manifest: manifest('kinds'), notices: [{ kind: 'a' }, { kind: 'a' }] });
    expect(() => checkBundled([kinds])).toThrow(/notice kind kinds\.a/);
  });

  it('rejects a switch key the host uses, and names that are not identifiers', () => {
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), jev: { features: [{ key: 'pluginDecide', default: false }] } })])).toThrow(/Jev switch pluginDecide/);
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), jev: { features: [{ key: 'a.b', default: false }] } })])).toThrow(/Jev switch a\.b/);
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), notices: [{ kind: 'a b' }] })])).toThrow(/notice kind a b/);
  });

  it('rejects an alias that two plugins claim, or that lands on nothing declared', () => {
    const one = definePlugin({ manifest: manifest('one'), jev: { features: [{ key: 'a', default: false }] }, notices: [{ kind: 'n' }], adopts: { jevFeatures: { old: 'a' }, noticeKinds: { old: 'n' } } });
    const two = definePlugin({ manifest: manifest('two'), jev: { features: [{ key: 'a', default: false }] }, adopts: { jevFeatures: { old: 'a' } } });
    const three = definePlugin({ manifest: manifest('three'), notices: [{ kind: 'n' }], adopts: { noticeKinds: { old: 'n' } } });
    expect(() => checkBundled([one, two])).toThrow(/adopted Jev switch old/);
    expect(() => checkBundled([one, three])).toThrow(/adopted notice kind old/);
    expect(() => checkBundled([{ ...one, adopts: { jevFeatures: { old: 'missing' } } }])).toThrow(/adopts Jev switch old/);
    expect(() => checkBundled([{ ...one, adopts: { noticeKinds: { old: 'missing' } } }])).toThrow(/adopts notice kind old/);
    expect(() => checkBundled([{ ...one, adopts: { jevFeatures: { pluginDecide: 'a' } } }])).toThrow(/adopts Jev switch pluginDecide/);
  });

  it('rejects a notice kind or Jev switch placed in a loop, by a typo, or in both directions', () => {
    const loopKinds = definePlugin({ manifest: manifest('probe'), notices: [{ kind: 'a', after: 'probe.b' }, { kind: 'b', after: 'probe.a' }] });
    expect(() => checkBundled([loopKinds])).toThrow(/Notice kind probe\.a: its placement loops/);
    const loopSwitches = definePlugin({ manifest: manifest('probe'), jev: { features: [{ key: 'a', default: false, after: 'probe.b' }, { key: 'b', default: false, before: 'probe.a' }] } });
    expect(() => checkBundled([loopSwitches])).toThrow(/Jev switch probe\.a: its placement loops/);
    const self = definePlugin({ manifest: manifest('probe'), jev: { features: [{ key: 'on', default: false, after: 'probe.on' }] } });
    expect(() => checkBundled([self])).toThrow(/Jev switch probe\.on: its placement loops/);
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), notices: [{ kind: 'a', after: 'probe.x' }] })])).toThrow(/Notice kind probe\.a follows probe\.x/);
    // Preserves vocabulary for plugins absent from the current build.
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), notices: [{ kind: 'a', after: 'nowhere.x' }] })])).not.toThrow();
    const both = { manifest: manifest('probe'), notices: [{ kind: 'a', after: 'plugin', before: 'plugin' }] } as unknown as PluginDescriptor;
    expect(() => checkBundled([both])).toThrow(/notice kind a: one of after or before/);
    expect(() => checkBundled([definePlugin({ manifest: manifest('probe'), notices: [{ kind: 'a', before: 'plugin' }, { kind: 'b', after: 'probe.a' }] })])).not.toThrow();
  });

  it('rejects an alias from a stamped or host identity, which adoption would rewrite or take over', () => {
    const one = definePlugin({ manifest: manifest('one'), jev: { features: [{ key: 'a', default: false }] }, notices: [{ kind: 'n' }], slots: { phoneSections: [{ id: 'pane' }] } });
    // Adopting one.a as a collides with the legacy key’s deletion.
    expect(() => checkBundled([{ ...one, adopts: { jevFeatures: { 'one.a': 'a' } } }])).toThrow(/adopts Jev switch one\.a: a pre-plugin name/);
    expect(() => checkBundled([{ ...one, adopts: { noticeKinds: { plugin: 'n' } } }])).toThrow(/adopts notice kind plugin: a pre-plugin name/);
    expect(() => checkBundled([{ ...one, adopts: { noticeKinds: { 'other.n': 'n' } } }])).toThrow(/adopts notice kind other\.n/);
    expect(() => checkBundled([{ ...one, adopts: { phoneSections: { archive: 'pane' } } }])).toThrow(/adopts phone section archive: a pre-plugin name/);
    expect(() => checkBundled([{ ...one, adopts: { phoneSections: { 'one.pane': 'pane' } } }])).toThrow(/adopts phone section one\.pane/);
    expect(() => checkBundled([{ ...one, adopts: { jevFeatures: { old: 'a' }, noticeKinds: { old: 'n' }, phoneSections: { old: 'pane' } } }])).not.toThrow();
  });
});
