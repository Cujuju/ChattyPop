// The Conversation view: a message's conversation from its stored links (src/core/conversations), privacy applied.
import type { ConversationView } from '@shared/contract';
import type { Db } from '../db';
import { LINK_KIND } from '../conversations/linker';
import { CONVERSATION_SQL, type ConversationLinkRow } from '../conversations/read';
import { messagesByIds } from './messages';

/** Most messages shown; past it, those nearest the opened message in time. */
export const CONVERSATION_MAX = 200;

export function conversation(db: Db, messageId: string): ConversationView {
  const anchor = db.prepare('SELECT channel_id AS channelId, ts FROM messages WHERE id = ?').get(messageId) as { channelId: string; ts: number } | undefined;
  if (!anchor) return { messages: [], linkedIds: [], pending: false };
  const rows = db.prepare(CONVERSATION_SQL).all(messageId) as ConversationLinkRow[];
  const near = rows.sort((a, b) => Math.abs(a.ts - anchor.ts) - Math.abs(b.ts - anchor.ts)).slice(0, CONVERSATION_MAX);
  const ids = new Set([messageId, ...near.map((r) => r.message_id)]);
  // messagesByIds applies privacy mode; show oldest first.
  const messages = messagesByIds(db, [...ids]).sort((a, b) => a.ts - b.ts);
  const shown = new Set(messages.map((m) => m.id));
  const byReply = near.filter((r) => r.kind === LINK_KIND.reply && shown.has(r.message_id)).map((r) => r.message_id);
  // Queued relinking from before the newest message read may change what it shows.
  const newest = Math.max(anchor.ts, ...rows.map((r) => r.ts));
  const pending = db.prepare('SELECT 1 FROM conversation_link_queue WHERE channel_id = ? AND from_ts <= ?').get(anchor.channelId, newest) !== undefined;
  return { messages, linkedIds: shown.has(messageId) ? [...new Set([messageId, ...byReply])] : byReply, pending };
}
