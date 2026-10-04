// A bundled plugin's preferences in core (docs/plugin-architecture.md §4): its declared values, read normalized, written
// normalized; undeclared names throw. Writes do nothing once the plugin unloads.
import { pluginSettingKey, type PluginDescriptor } from '@shared/bundledTypes';
import { preferenceOf, readPreference, type CorePreferences, type PreferenceNames, type PreferenceValue } from '@shared/preferences';
import { getSetting } from '../db';
import type { Registrations } from './api';
import type { BundledDeps } from './bundled';

/** `plugin`'s preferences over the archive's settings table. */
export function corePreferences<D extends PluginDescriptor>(plugin: D, bundled: BundledDeps, reg: Registrations, live: () => boolean): CorePreferences<D> {
  const id = plugin.manifest.id;
  const stored = (name: string): unknown => {
    preferenceOf(plugin, name);
    return getSetting(bundled.ready(), pluginSettingKey(id, name));
  };
  // The declaration's normalize produced it, so it has the declared type.
  const get = <N extends PreferenceNames<D>>(name: N): PreferenceValue<D, N> => readPreference(preferenceOf(plugin, name), stored(name)) as PreferenceValue<D, N>;
  return {
    get,
    stored,
    set: (name, value) => {
      const p = preferenceOf(plugin, name);
      if (live()) bundled.saveSetting(pluginSettingKey(id, name), p.normalize(value));
    },
    onChange: (name, fn) => {
      preferenceOf(plugin, name);
      reg.onSettingChanged.push({ key: pluginSettingKey(id, name), fn: () => fn(get(name)) });
    },
  };
}
