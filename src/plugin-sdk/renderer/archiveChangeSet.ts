import { archiveParent } from './archiveScope';
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
  /** The only messages of `channelId` the change touched; null when any of its rows may have changed. */
  messagesChanged(channelId: string): ReadonlySet<string> | null;
  inserted?: ArchiveChange['inserted'];
  nameGuildIds?: ReadonlySet<string>;
  pluginIds: ReadonlySet<string>;
}

/** Narrows each channel's kinds before merging, preserving mixed-batch insert safety and global invalidations. */
export function matchingChange(change: ArchiveChange, deps: ArchiveDeps, guildOf: (channelId: string) => string | undefined): ArchiveChange {
  const scope = deps.scope?.() ?? 'all';
  const changes: ArchiveChange['changes'] = {};
  for (const [id, kinds] of Object.entries(change.changes)) {
    const matches = scope === 'all' || id === '' || scope.channelIds?.some((channel) => channel === id || channel === archiveParent(id)) || scope.guildIds?.includes(guildOf(id) ?? '');
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
  const named = change.messageIds && Object.entries(change.messageIds).filter(([id]) => id in changes);
  const { messageIds: _all, ...rest } = change;
  return { ...rest, changes, ...(named?.length ? { messageIds: Object.fromEntries(named) } : {}) };
}

export function changeSet(change: ArchiveChange): ArchiveChangeSet {
  const inserts = new Set(change.insertOnlyChannelIds);
  const named = new Map(Object.entries(change.messageIds ?? {}).map(([id, ids]) => [id, new Set(ids)]));
  return {
    kinds: new Set(Object.values(change.changes).flat()),
    channelIds: new Set(Object.keys(change.changes)),
    insertOnly: (channelId) => inserts.has(channelId),
    messagesChanged: (channelId) => named.get(channelId) ?? null,
    inserted: change.inserted,
    nameGuildIds: change.nameGuildIds ? new Set(change.nameGuildIds) : undefined,
    pluginIds: new Set(change.pluginIds),
  };
}
export { ArchiveChanges };
