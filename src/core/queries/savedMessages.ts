// Native saved messages may be unarchived; apply privacy before they leave core, including hidden references in summaries.
import { savedAuthor, savedTarget, type SavedMessage, type SavedTarget, type SavedVisible } from '@shared/savedMessages';
import { DM_CHANNEL_TYPES } from '@shared/discord';
import type { PluginDb } from '../plugins/pluginDb';
import { NOTHING_HIDDEN_SQL, visibleMessageRefSql, visibleMessageSql } from './privacy';
import { displayNameSql } from './names';
export { savedWritableChannels } from './savedWritableChannels';

export function savedTargetVisible(db: PluginDb, value: SavedTarget): boolean {
  const target = savedTarget(value);
  return !!db.prepare(`SELECT ${visibleMessageRefSql('?', '?')} AND (${NOTHING_HIDDEN_SQL} OR EXISTS (SELECT 1 FROM channels WHERE id = ?)) AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ? AND channel_id != ?)`).pluck().get(target.channelId, target.messageId, target.channelId, target.messageId, target.channelId);
}
export function filterSavedMessages(db: PluginDb, items: SavedMessage[], bookmarkIds: string[]): SavedVisible {
  const scope = db.prepare('SELECT id FROM hidden_ids').pluck().all() as string[];
  const eligible = items.filter((m) => savedTargetVisible(db, m));
  // Existing visible archive data fills legacy/deleted records' missing names and avatars in one local query.
  const previews = db.prepare(`SELECT m.id, m.channel_id AS channelId, m.author_id AS authorId, u.avatar,
    ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName, c.name AS channelName, c.kind
    FROM messages m LEFT JOIN users u ON u.id = m.author_id JOIN channels c ON c.id = m.channel_id
    WHERE m.id IN (SELECT value FROM json_each(?)) AND ${visibleMessageSql('m')}`)
    .all(JSON.stringify(eligible.map((m) => m.messageId))) as { id: string; channelId: string; authorId: string; avatar: string | null; authorName: string; channelName: string; kind: number }[];
  const byId = new Map(previews.map((m) => [m.id, m]));
  const enriched = eligible.map((row) => {
    const local = byId.get(row.messageId);
    if (!local || local.channelId !== row.channelId) return row;
    const author = row.author ?? savedAuthor({ id: local.authorId, avatar: local.avatar });
    return { ...row, authorName: row.authorName || local.authorName,
      channelName: row.channelName || `${DM_CHANNEL_TYPES.has(local.kind) ? '@' : '#'}${local.channelName}`, ...(author ? { author } : {}) };
  });
  // Run the hidden-reference scan on the final metadata too, before anything reaches the renderer.
  const visible = enriched.filter((m) => !scope.some((id) => JSON.stringify(m).includes(id)));
  // A bare bookmark id says nothing about its channel. Only expose identities whose archived messages are visible,
  // or whose explicit saved row passed the filter, rather than guessing the privacy of an unarchived identity.
  const allowed = new Set(visible.map((m) => m.messageId));
  for (const id of db.prepare(`SELECT id FROM messages m WHERE id IN (SELECT value FROM json_each(?)) AND ${visibleMessageSql('m')}`).pluck().all(JSON.stringify(bookmarkIds)) as string[]) allowed.add(id);
  return { items: visible, bookmarkIds: bookmarkIds.filter((id) => allowed.has(id)) };
}
