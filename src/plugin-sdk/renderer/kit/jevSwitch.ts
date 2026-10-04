// A plugin's Settings → Jev switch in its windows, named as its descriptor declares it; the host stamps the stored key.
import { pluginJevFeature, type JevFeatureRef, type PluginDescriptor } from '@shared/bundledTypes';
import { jevFeatureOn } from '@shared/settings';
import { aiSettings } from '@/state/preferences';
import { jevFeatureLocked, toggleJevFeature } from '@/state/jevStatus';

/** One Settings → Jev switch; each read is reactive. */
export interface JevSwitch {
  on(): boolean;
  /** It can't be turned on while Jev isn't set up; one that is on can always be turned off. */
  locked(): boolean;
  /** Turns it on or off, then re-reads Jev's status. */
  set(on: boolean): void;
}

/** Switch `key`: one `plugin` declares (jev.features), or the host's. Throws on a key it doesn't declare. */
export function jevSwitch<D extends PluginDescriptor>(plugin: D, key: JevFeatureRef<D>): JevSwitch {
  const f = pluginJevFeature(plugin, key);
  return {
    on: () => jevFeatureOn(aiSettings().jev, f),
    locked: () => jevFeatureLocked(f),
    set: (on) => toggleJevFeature(f, on),
  };
}
