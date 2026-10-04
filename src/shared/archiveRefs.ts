// Structured archive references and the names of host-owned visibility views.
import { pluginTableName, TABLE_NAME, type PluginDescriptor } from './bundledTypes';

/** A message reference, or a JSON array of channel ids, stored in an owned plugin table. */
export type ArchiveRef = { channel: string; message?: string; channels?: never } | { channels: string; channel?: never; message?: never };

/** Validates table and column identifiers and rejects ambiguous reference shapes. */
export function checkArchiveRefs(plugin: PluginDescriptor): void {
  for (const [table, ref] of Object.entries(plugin.archiveRefs ?? {})) {
    pluginTableName(plugin.manifest.id, table);
    const keys = Object.keys(ref);
    const valid = 'channels' in ref
      ? keys.length === 1 && typeof ref.channels === 'string'
      : typeof ref.channel === 'string' && keys.every((key) => key === 'channel' || key === 'message');
    if (!valid || !Object.values(ref).every((column) => typeof column === 'string' && TABLE_NAME.test(column)))
      throw new Error(`${plugin.manifest.id} archive reference ${table}: expected channel/message columns or one channels column`);
  }
}

/** A declared table's host-owned, read-only visibility view. */
export function visibleTableName(plugin: PluginDescriptor, name: string): string {
  if (!Object.hasOwn(plugin.archiveRefs ?? {}, name)) throw new Error(`${plugin.manifest.id} has no archive reference for ${name}`);
  return `${pluginTableName(plugin.manifest.id, name)}_visible`;
}
