// Builds conversations without AI from reply chains, then nearby messages by participants or mentioning them with short gaps.
import type { ConversationView } from '@shared/contract';
import { MS_PER_MIN } from '@shared/units';
import type { Db } from '../db';
import { rawJsonSql } from './messageContent';
import { REPLY_MESSAGE_TYPE, USER_MENTION } from './messageExtras';
import { messagesByIds } from './messages';

/** Maximum gap between related conversation messages. */
export const CONVERSATION_GAP_MS = 5 * MS_PER_MIN;
/** Most messages shown: bounds the reply walk and the window. */
export const CONVERSATION_MAX = 200;
/** Deepest reply chain followed upward. */
const REPLY_DEPTH_MAX = 50;
/** Channel messages read per side of the heuristic walk (four per shown message): a busy channel can't make one view scan it all. */
const SCAN_MAX = CONVERSATION_MAX * 4;

interface Row {
  id: string;
  authorId: string;
  ts: number;
  replyToId: string | null;
  content: string;
}

const ROW_SQL = `SELECT m.id, m.author_id AS authorId, m.ts, m.content,
  CASE WHEN ${rawJsonSql('$.type')} = ${REPLY_MESSAGE_TYPE} THEN ${rawJsonSql('$.message_reference.message_id')} END AS replyToId
  FROM messages m`;

const mentioned = (content: string): string[] => [...content.matchAll(USER_MENTION)].map((m) => m[1]!);

export function conversation(db: Db, messageId: string): ConversationView {
  const byId = db.prepare(`${ROW_SQL} WHERE m.id = ?`);
  const anchor = byId.get(messageId) as Row | undefined;
  if (!anchor) return { messages: [], linkedIds: [] };
  const channelId = db.prepare('SELECT channel_id FROM messages WHERE id = ?').pluck().get(messageId) as string;

  // Up the reply chain to its root.
  const linked = new Map<string, Row>([[anchor.id, anchor]]);
  let root = anchor;
  for (let depth = 0; root.replyToId && depth < REPLY_DEPTH_MAX; depth++) {
    const parent = byId.get(root.replyToId) as Row | undefined;
    if (!parent || linked.has(parent.id)) break;
    linked.set(parent.id, parent);
    root = parent;
  }
  // Every reply below the root, level by level (replies are newer than what they answer).
  let frontier = [root.id];
  while (frontier.length && linked.size < CONVERSATION_MAX) {
    const replies = db
      .prepare(`SELECT * FROM (${ROW_SQL} WHERE m.channel_id = ? AND m.ts >= ?) WHERE replyToId IN (${frontier.map(() => '?').join(',')})`)
      .all(channelId, root.ts, ...frontier) as Row[];
    frontier = replies.filter((r) => !linked.has(r.id)).map((r) => r.id);
    for (const r of replies) linked.set(r.id, r);
  }

  // Participants: who wrote the linked messages and who they @mention.
  const participants = new Set<string>();
  for (const r of linked.values()) {
    participants.add(r.authorId);
    for (const id of mentioned(r.content)) participants.add(id);
  }
  const related = (r: Row): boolean => participants.has(r.authorId) || mentioned(r.content).some((id) => participants.has(id));

  // Includes participant messages near linked messages, extending each end through related messages within the gap. Intervening unrelated messages do not break continuation.
  const linkedTs = [...linked.values()].map((r) => r.ts).sort((a, b) => a - b);
  const [first, last] = [linkedTs[0]!, linkedTs.at(-1)!];
  const nearLinked = (ts: number): boolean => linkedTs.some((t) => Math.abs(ts - t) <= CONVERSATION_GAP_MS);
  const rows = (where: string, order: 'ASC' | 'DESC', ...params: number[]): Row[] =>
    db.prepare(`${ROW_SQL} WHERE m.channel_id = ? AND ${where} ORDER BY m.ts ${order} LIMIT ?`).all(channelId, ...params, SCAN_MAX) as Row[];
  const shown = new Set(linked.keys());
  const take = (r: Row): void => {
    if (shown.size < CONVERSATION_MAX && related(r)) shown.add(r.id);
  };
  for (const r of rows('m.ts BETWEEN ? AND ?', 'ASC', first, last)) if (nearLinked(r.ts)) take(r);
  const walk = (side: Row[], from: number): void => {
    let edge = from;
    for (const r of side) {
      if (Math.abs(r.ts - edge) > CONVERSATION_GAP_MS) break;
      if (related(r)) edge = r.ts;
      take(r);
    }
  };
  walk(rows('m.ts > ?', 'ASC', last), last);
  walk(rows('m.ts < ?', 'DESC', first), first);
  // messagesByIds applies privacy mode; show oldest first.
  const messages = messagesByIds(db, [...shown]).sort((a, b) => a.ts - b.ts);
  return { messages, linkedIds: [...linked.keys()].filter((id) => messages.some((m) => m.id === id)) };
}
