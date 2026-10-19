// The Conversation view: a message's conversation from its stored links (src/core/conversations), privacy applied.
import type { ConversationMember, ConversationView } from '@shared/contract';
import type { Db } from '../db';
import { JUDGE_BELOW, LINK_KIND } from '../conversations/linker';
import type { ConversationMark } from '../conversations/marks';
import { CONVERSATION_SQL, type ConversationLinkRow } from '../conversations/read';
import { channelReach } from '../conversations/store';
import { messagesByIds } from './messages';
import { visibleMessageSql } from './privacy';

/** Most messages shown; past it, those nearest the opened message in time. */
export const CONVERSATION_MAX = 200;
/** Nearby non-members shown, nearest the opened message: enough to spot a missed reply without burying the conversation. */
export const NEARBY_MAX = 50;

export interface ConversationOptions {
  /** Also the root channel's other messages from the root to the last member plus the channel's reach. */
  nearby?: boolean;
}

const EXPLICIT: ReadonlySet<string> = new Set([LINK_KIND.reply, LINK_KIND.thread]);

/** How many rows continue each row, directly or not. */
function branchSizes(rows: readonly ConversationLinkRow[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const r of rows) if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r.message_id]);
  const sizes = new Map<string, number>();
  // Rows come root first, parents before children: sum from the end.
  for (const r of [...rows].reverse()) sizes.set(r.message_id, (children.get(r.message_id) ?? []).reduce((n, c) => n + 1 + (sizes.get(c) ?? 0), 0));
  return sizes;
}

/** The root channel's visible non-members between the root and the last member plus reach, nearest `anchorTs` first. */
function nearby(db: Db, rows: readonly ConversationLinkRow[], anchorTs: number): { ids: string[]; more: boolean } {
  const root = rows[0]!;
  const inChannel = rows.filter((r) => r.channel_id === root.channel_id);
  const untilTs = Math.max(...inChannel.map((r) => r.ts)) + channelReach(db, root.channel_id);
  // After the root as marks.ts orders messages: by time, then by id as a number (a longer id is larger).
  const ids = db.prepare(`SELECT m.id FROM messages m WHERE m.channel_id = ? AND m.ts <= ? AND ${visibleMessageSql('m')}
    AND (m.ts > ? OR (m.ts = ? AND (length(m.id) > length(?) OR (length(m.id) = length(?) AND m.id > ?))))
    AND m.id NOT IN (SELECT value FROM json_each(?)) ORDER BY abs(m.ts - ?) LIMIT ?`)
    .pluck().all(root.channel_id, untilTs, root.ts, root.ts, root.message_id, root.message_id, root.message_id,
      JSON.stringify(rows.map((r) => r.message_id)), anchorTs, NEARBY_MAX + 1) as string[];
  return { ids: ids.slice(0, NEARBY_MAX), more: ids.length > NEARBY_MAX };
}

export function conversation(db: Db, messageId: string, options: ConversationOptions = {}): ConversationView {
  const empty: ConversationView = { messages: [], linkedIds: [], pending: false, rootId: null, members: {}, marks: {}, memberCount: 0, nearbyMore: false };
  const anchor = db.prepare(`SELECT m.channel_id AS channelId, m.ts FROM messages m WHERE m.id = ? AND ${visibleMessageSql('m')}`)
    .get(messageId) as { channelId: string; ts: number } | undefined;
  if (!anchor) return empty;
  const rows = db.prepare(CONVERSATION_SQL).all(messageId) as ConversationLinkRow[];
  const near = [...rows].sort((a, b) => Math.abs(a.ts - anchor.ts) - Math.abs(b.ts - anchor.ts)).slice(0, CONVERSATION_MAX);
  const extra = options.nearby && rows.length ? nearby(db, rows, anchor.ts) : { ids: [], more: false };
  const ids = new Set([messageId, ...near.map((r) => r.message_id)]);
  // messagesByIds applies privacy mode; show oldest first.
  const messages = messagesByIds(db, [...ids, ...extra.ids]).sort((a, b) => a.ts - b.ts);
  const shown = new Set(messages.map((m) => m.id));
  // Every shown message's mark, members or not: a removed message shown nearby keeps its Undo.
  const marks = Object.fromEntries((db.prepare('SELECT message_id AS id, mark FROM conversation_marks WHERE message_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...shown])) as { id: string; mark: ConversationMark }[]).map((r) => [r.id, r.mark]));
  const branch = branchSizes(rows);
  const members: Record<string, ConversationMember> = {};
  for (const r of near) {
    if (!shown.has(r.message_id)) continue;
    members[r.message_id] = {
      kind: r.kind,
      confidence: r.confidence,
      questionable: r.kind === LINK_KIND.judged || (r.kind === LINK_KIND.inferred && r.confidence < JUDGE_BELOW),
      explicit: EXPLICIT.has(r.kind),
      branch: branch.get(r.message_id) ?? 0,
    };
  }
  // Not linked yet: the opened message alone.
  if (!rows.length && shown.has(messageId)) {
    members[messageId] = { kind: LINK_KIND.start, confidence: 0, questionable: false, explicit: false, branch: 0 };
  }
  const byReply = near.filter((r) => r.kind === LINK_KIND.reply && shown.has(r.message_id)).map((r) => r.message_id);
  // Queued relinking from before the newest message read may change what it shows.
  const newest = Math.max(anchor.ts, ...rows.map((r) => r.ts));
  const pending = db.prepare('SELECT 1 FROM conversation_link_queue WHERE channel_id = ? AND from_ts <= ?').get(anchor.channelId, newest) !== undefined;
  return {
    messages,
    linkedIds: shown.has(messageId) ? [...new Set([messageId, ...byReply])] : byReply,
    pending,
    rootId: rows[0]?.message_id ?? (shown.has(messageId) ? messageId : null),
    members,
    marks,
    memberCount: Math.max(rows.length, members[messageId] ? 1 : 0),
    nearbyMore: extra.more,
  };
}
