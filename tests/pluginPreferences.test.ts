// Core and main share normalized declared preferences. Descriptor references must name declared preferences and valid fields.
import { describe, expect, it, vi } from 'vitest';
import { definePreference, finiteOr } from '@plugin-sdk/shared';
import { checkBundled } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { corePreferences } from '../src/core/plugins/preferences';
import { mainPreferences } from '../src/main/plugins/preferences';
import { getSetting, setSetting } from '../src/core/db';
import { tempDb } from './helpers';

const manifest = { id: 'prefs', name: 'Prefs', version: '1', description: '' };
const preferences = {
  count: definePreference<number | null>({ default: null, normalize: finiteOr(null) }),
  server: definePreference({ default: { url: 'http://127.0.0.1:1/', nested: { on: false } }, normalize: (v: unknown) => ({ url: String((v as { url?: unknown })?.url ?? 'http://127.0.0.1:1/'), nested: { on: false } }) }),
};
const plugin = { manifest, preferences } satisfies PluginDescriptor;
const descriptor = (extra: Partial<PluginDescriptor>): PluginDescriptor => ({ manifest, preferences, ...extra });

describe('checkBundled over preferences', () => {
  it('accepts references to declared preferences and fields of their defaults', () => {
    expect(() => checkBundled([descriptor({
      preferences: { ...preferences, shown: definePreference({ ...preferences.server, phone: ['nested.on'] }) },
      network: { ownerUrls: [{ setting: 'server', field: 'url', fallback: 'http://127.0.0.1:1/' }] },
      adopts: { settings: { 'old.count': 'count' }, settingFields: [{ key: 'ai', field: 'url', name: 'server' }] },
    })])).not.toThrow();
  });

  it('rejects a phone view naming a field its value lacks, a bad name, and a missing normalizer', () => {
    const phone = (paths: readonly string[]) => descriptor({ preferences: { server: { ...preferences.server, phone: paths } } });
    for (const paths of [[], ['port'], ['nested.off'], ['a..b'], ['__proto__.x']]) expect(() => checkBundled([phone(paths)])).toThrow(/phone fields/);
    expect(() => checkBundled([descriptor({ preferences: { 'bad.name': preferences.count } })])).toThrow(/preference bad\.name/);
    expect(() => checkBundled([descriptor({ preferences: { count: { default: null } as never } })])).toThrow(/normalizer/);
  });

  it('rejects an owner address or adoption naming an undeclared preference or a field its value lacks', () => {
    const url = (setting: string, field: string) => descriptor({ network: { ownerUrls: [{ setting, field, fallback: 'http://127.0.0.1:1/' }] } });
    expect(() => checkBundled([url('missing', 'url')])).toThrow(/owner URL missing\.url/);
    expect(() => checkBundled([url('server', 'port')])).toThrow(/owner URL server\.port/);
    expect(() => checkBundled([descriptor({ adopts: { settings: { 'old.count': 'missing' } } })])).toThrow(/adopts setting old\.count/);
    expect(() => checkBundled([descriptor({ adopts: { settingFields: [{ key: 'ai', field: 'port', name: 'server' }] } })])).toThrow(/adopts field ai\.port/);
    expect(() => checkBundled([descriptor({ adopts: { settingFields: [{ key: 'ai', field: 'url', name: 'missing' }] } })])).toThrow(/adopts field ai\.url/);
  });
});

describe("core's ctx.preferences", () => {
  const harness = () => {
    const db = tempDb();
    const reg = { onSettingChanged: [] as { key: string; fn: () => void }[] };
    let live = true;
    const prefs = corePreferences(plugin, { ready: () => db, saveSetting: (key: string, value: unknown) => setSetting(db, key, value) } as never, reg as never, () => live);
    return { db, reg, prefs, off: () => void (live = false) };
  };

  it('reads the default while nothing is stored, and the stored value normalized; keeps the raw value readable', () => {
    const { db, prefs } = harness();
    expect(prefs.get('count')).toBeNull();
    expect(prefs.stored('count')).toBeUndefined();
    setSetting(db, 'plugin.prefs.count', 'not a number');
    expect([prefs.get('count'), prefs.stored('count')]).toEqual([null, 'not a number']);
  });

  it('saves normalized under plugin.<id>.<name>, tells onChange the normalized value, and writes nothing once unloaded', () => {
    const { db, reg, prefs, off } = harness();
    const heard: unknown[] = [];
    prefs.onChange('server', (value) => void heard.push(value));
    prefs.set('server', { url: 'http://10.0.0.1/', nested: { on: true } });
    expect(getSetting(db, 'plugin.prefs.server')).toEqual({ url: 'http://10.0.0.1/', nested: { on: false } });
    reg.onSettingChanged.find((h) => h.key === 'plugin.prefs.server')!.fn();
    expect(heard).toEqual([{ url: 'http://10.0.0.1/', nested: { on: false } }]);
    off();
    prefs.set('count', 5);
    expect(getSetting(db, 'plugin.prefs.count')).toBeUndefined();
  });

  it('throws for a name the descriptor does not declare', () => {
    const { prefs } = harness();
    expect(() => prefs.get('missing' as never)).toThrow(/declares no preference missing/);
    expect(() => prefs.set('missing' as never, 1 as never)).toThrow(/declares no preference missing/);
    expect(() => prefs.onChange('missing' as never, () => undefined)).toThrow(/declares no preference missing/);
  });
});

describe("main's ctx.preferences", () => {
  const harness = () => {
    const stored = new Map<string, unknown>();
    const listeners: ((e: AppEvent) => void)[] = [];
    const core = {
      call: vi.fn(async (method: string, key: string, value?: unknown) => (method === 'getSetting' ? stored.get(key) : void stored.set(key, value))),
      on: (_name: 'event', fn: (e: AppEvent) => void) => void listeners.push(fn),
    };
    const staged: (() => void)[] = [];
    const prefs = mainPreferences(plugin, core as never, (apply) => void staged.push(apply));
    const emit = (e: AppEvent) => listeners.forEach((fn) => fn(e));
    return { stored, core, prefs, staged, emit };
  };

  it("reads through core normalized, and saves through core's setSetting normalized", async () => {
    const { stored, core, prefs } = harness();
    await expect(prefs.get('count')).resolves.toBeNull();
    stored.set('plugin.prefs.count', 4);
    await expect(prefs.get('count')).resolves.toBe(4);
    await prefs.set('server', { url: 'http://10.0.0.1/', nested: { on: true } });
    expect(core.call).toHaveBeenLastCalledWith('setSetting', 'plugin.prefs.server', { url: 'http://10.0.0.1/', nested: { on: false } });
  });

  it('listens once the activation succeeds, to its own preference only, handing the normalized value', () => {
    const { prefs, staged, emit } = harness();
    const heard: unknown[] = [];
    prefs.onChange('count', (value) => void heard.push(value));
    emit({ type: 'setting-changed', key: 'plugin.prefs.count', value: 1 });
    expect(heard).toEqual([]);
    staged.forEach((apply) => apply());
    emit({ type: 'setting-changed', key: 'plugin.prefs.other', value: 2 });
    emit({ type: 'setting-changed', key: 'plugin.prefs.count', value: 'junk' });
    emit({ type: 'setting-changed', key: 'plugin.prefs.count', value: 3 });
    expect(heard).toEqual([null, 3]);
    expect(() => prefs.onChange('missing' as never, () => undefined)).toThrow(/declares no preference missing/);
  });
});
