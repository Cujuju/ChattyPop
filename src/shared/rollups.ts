import { pluginTableName, type PluginDescriptor } from './bundledTypes';

export interface RollupStatus {
  /** Full rebuild only; incremental work keeps exact reads available. */
  building: boolean;
  /** Any queued or running maintenance, including a full rebuild. */
  maintaining?: boolean;
  dirty: number; total: number; error: string | null;
}

/** A versioned rollup's host-owned visibility view; compute tables remain internal to the service. */
export function rollupView(plugin: PluginDescriptor, name: string, version: number, grain?: 'all-time' | 'folded' | 'live'): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(name) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid rollup view');
  return `${pluginTableName(plugin.manifest.id, `rollup_${name}_v${version}`)}${grain === 'live' ? '_live' : grain === 'folded' ? '_folded' : grain ? '_all_time' : ''}_visible`;
}
