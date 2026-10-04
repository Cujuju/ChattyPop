// A bundled plugin's preferences in main (docs/plugin-architecture.md §4): core stores them, so main reads and writes
// through its core client, normalized as core does; undeclared names throw.
import { pluginSettingKey, type PluginDescriptor } from '@shared/bundledTypes';
import { preferenceOf, readPreference, type MainPreferences, type PreferenceNames, type PreferenceValue } from '@shared/preferences';
import type { MainCore } from '../coreClient';

/** `plugin`'s preferences through `core`; `stage` holds onChange listeners until the activation succeeds. */
export function mainPreferences<D extends PluginDescriptor>(plugin: D, core: MainCore, stage: (apply: () => void) => void): MainPreferences<D> {
  const key = (name: string): string => pluginSettingKey(plugin.manifest.id, name);
  return {
    // The declaration's normalize produced it, so it has the declared type.
    get: async <N extends PreferenceNames<D>>(name: N) => readPreference(preferenceOf(plugin, name), await core.call('getSetting', key(name))) as PreferenceValue<D, N>,
    set: async (name, value) => {
      const p = preferenceOf(plugin, name);
      await core.call('setSetting', key(name), p.normalize(value));
    },
    onChange: <N extends PreferenceNames<D>>(name: N, fn: (value: PreferenceValue<D, N>) => void) => {
      const p = preferenceOf(plugin, name);
      stage(() => core.on('event', (e) => {
        if (e.type === 'setting-changed' && e.key === key(name)) fn(readPreference(p, e.value) as PreferenceValue<D, N>);
      }));
    },
  };
}
