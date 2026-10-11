// Native saved messages may be unarchived; apply privacy before they leave core, including hidden references in summaries.
import { savedTarget, type SavedMessage, type SavedTarget, type SavedVisible, type SavedChannelAccess } from '@shared/savedMessages';
import { DM_CHANNEL_TYPES, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { PRIVATE_THREAD_TYPE, PERMISSIONS, can } from '@shared/permissions';
import type { PluginDb } from '../plugins/pluginDb';
import type { Db } from '../db';
import { NOTHING_HIDDEN_SQL, visibleChannelSql, visibleMessageRefSql, visibleMessageSql } from './privacy';
import { accessOf, memberFacts } from './mentions';

export function savedTargetVisible(db: PluginDb, value: SavedTarget): boolean {
  const target = savedTarget(value);
  return !!db.prepare(`SELECT ${visibleMessageRefSql('?', '?')} AND (${NOTHING_HIDDEN_SQL} OR EXISTS (SELECT 1 FROM channels WHERE id = ?)) AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ? AND channel_id != ?)`).pluck().get(target.channelId, target.messageId, target.channelId, target.messageId, target.channelId);
}
export function filterSavedMessages(db: PluginDb, items: SavedMessage[], bookmarkIds: string[]): SavedVisible {
  const scope = db.prepare('SELECT id FROM hidden_ids').pluck().all() as string[];
  const visible = items.filter((m) => savedTargetVisible(db, m) && !scope.some((id) => JSON.stringify(m).includes(id)));
  // A bare bookmark id says nothing about its channel. Only expose identities whose archived messages are visible,
  // or whose explicit saved row passed the filter, rather than guessing the privacy of an unarchived identity.
  const allowed = new Set(visible.map((m) => m.messageId));
  for (const id of db.prepare(`SELECT id FROM messages m WHERE id IN (SELECT value FROM json_each(?)) AND ${visibleMessageSql('m')}`).pluck().all(JSON.stringify(bookmarkIds)) as string[]) allowed.add(id);
  return { items: visible, bookmarkIds: bookmarkIds.filter((id) => allowed.has(id)) };
}
/** Native new saves require read-history access; existing saved records remain editable after access is lost. */
export function savedWritableChannels(db: Db, accountId: string): SavedChannelAccess[] {
  const channels = db.prepare(`SELECT id, guild_id AS guildId, parent_id AS parentId, kind, account_id AS accountId, closed_at AS closedAt FROM channels WHERE ${visibleChannelSql('id')}`).all() as { id: string; guildId: string; parentId: string | null; kind: number; accountId: string | null; closedAt: number | null }[];
  return channels.flatMap<SavedChannelAccess>((c) => {
    if (DM_CHANNEL_TYPES.has(c.kind)) return c.accountId === accountId && c.closedAt === null ? [{ channelId: c.id, guildId: null, parentId: null, privateThread: false }] : [];
    const thread = THREAD_CHANNEL_TYPES.has(c.kind), access = accessOf(db, c.guildId, thread && c.parentId ? c.parentId : c.id, thread);
    return can(access, accountId, memberFacts(db, c.guildId, accountId), PERMISSIONS.READ_MESSAGE_HISTORY) ? [{ channelId: c.id, guildId: c.guildId, parentId: thread ? c.parentId : null, privateThread: c.kind === PRIVATE_THREAD_TYPE }] : [];
  });
}
