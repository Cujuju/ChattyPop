import { ArchiveChanges } from '@shared/archiveChanges';
import type { ArchiveChange, ArchiveChangeKind } from '@shared/contract';
import type { Accessor } from 'solid-js';

export interface ArchiveDeps {
  kinds: readonly ArchiveChangeKind[];
  scope?: () => { channelIds?: readonly string[]; guildIds?: readonly string[] } | 'all';
  shown?: Accessor<boolean>;
  pluginIds?: readonly string[];
}
export interface ArchiveChangeSet {
  kinds: ReadonlySet<ArchiveChangeKind>;
  channelIds: ReadonlySet<string>;
  insertOnly(channelId: string): boolean;
  inserted?: ArchiveChange['inserted'];
  nameGuildIds?: ReadonlySet<string>;
  pluginIds: ReadonlySet<string>;
}

/** Narrows each channel's kinds before merging, preserving mixed-batch insert safety and global invalidations. */
export function matchingChange(change: ArchiveChange, deps: ArchiveDeps, guildOf: (channelId: string) => string | undefined): ArchiveChange {
  const scope = deps.scope?.() ?? 'all';
  const changes: ArchiveChange['changes'] = {};
  for (const [id, kinds] of Object.entries(change.changes)) {
    const matches = scope === 'all' || id === '' || scope.channelIds?.includes(id) || scope.guildIds?.includes(guildOf(id) ?? '');
    if (!matches) continue;
    const selected = kinds.filter((kind) => {
      if (!deps.kinds.includes(kind)) return false;
      if (kind === 'plugin' && deps.pluginIds && change.pluginIds && !deps.pluginIds.some((id) => change.pluginIds!.includes(id))) return false;
      if (kind === 'names' && scope !== 'all' && change.nameGuildIds) {
        const guilds = scope.guildIds ?? scope.channelIds?.flatMap((id) => guildOf(id) ?? []);
        if (guilds?.length && !guilds.some((id) => change.nameGuildIds!.includes(id))) return false;
      }
      return true;
    });
    if (selected.length) changes[id] = selected;
  }
  return { ...change, changes };
}

export function changeSet(change: ArchiveChange): ArchiveChangeSet {
  const inserts = new Set(change.insertOnlyChannelIds);
  return {
    kinds: new Set(Object.values(change.changes).flat()),
    channelIds: new Set(Object.keys(change.changes)),
    insertOnly: (channelId) => inserts.has(channelId),
    inserted: change.inserted,
    nameGuildIds: change.nameGuildIds ? new Set(change.nameGuildIds) : undefined,
    pluginIds: new Set(change.pluginIds),
  };
}
export { ArchiveChanges };
