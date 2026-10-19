// The Conversation view: a message's conversation from its stored links (src/core/conversations), privacy applied.
import type { ConversationMember, ConversationView } from '@shared/contract';
import { messageBefore } from '@shared/messageOrder';
import type { Db } from '../db';
import { JUDGE_BELOW, LINK_KIND } from '../conversations/linker';
import type { ConversationMark } from '../conversations/marks';
import { CONVERSATION_SQL, type ConversationLinkRow } from '../conversations/read';
import { channelReach } from '../conversations/store';
import { messagesByIds } from './messages';
import { visibleMessageSql } from './privacy';

/** Most messages shown; past it, those nearest the opened message in time. */
export const CONVERSATION_MAX = 200;
/** Enough unlinked messages to spot missed replies without rendering an unbounded list of full message rows. */
export const UNLINKED_MAX = 100;

export interface ConversationOptions {
  /** Extend unlinked messages past the last shown root-channel member by the channel's reach; in-between messages always show. */
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

/** Visible root-channel non-members within the shown members' span, optionally extended by reach, nearest the anchor first. */
function unlinked(db: Db, rows: readonly ConversationLinkRow[], shown: readonly ConversationLinkRow[], anchorTs: number, later: boolean): { ids: string[]; more: boolean } {
  const root = rows[0]!;
  const positions = shown.map((r) => ({ id: r.message_id, ts: r.ts, channelId: r.channel_id }))
    .sort((a, b) => messageBefore(a, b) ? -1 : messageBefore(b, a) ? 1 : 0);
  const first = positions[0];
  const last = positions.findLast((r) => r.channelId === root.channel_id);
  if (!first || !last) return { ids: [], more: false };
  const rootPosition = { id: root.message_id, ts: root.ts };
  const from = messageBefore(first, rootPosition) ? rootPosition : first;
  const upper = later ? 'm.ts <= @untilTs' : '(m.ts, length(m.id), m.id) <= (@untilTs, length(@untilId), @untilId)';
  const ids = db.prepare(`SELECT m.id FROM messages m WHERE m.channel_id = @channelId AND ${upper} AND ${visibleMessageSql('m')}
    AND (m.ts, length(m.id), m.id) > (@fromTs, length(@fromId), @fromId)
    AND m.id NOT IN (SELECT value FROM json_each(@members))
    ORDER BY abs(m.ts - @anchorTs), m.ts, length(m.id), m.id LIMIT @limit`)
    .pluck().all({ channelId: root.channel_id, untilTs: last.ts + (later ? channelReach(db, root.channel_id) : 0), untilId: last.id,
      fromTs: from.ts, fromId: from.id, members: JSON.stringify(rows.map((r) => r.message_id)), anchorTs, limit: UNLINKED_MAX + 1 }) as string[];
  return { ids: ids.slice(0, UNLINKED_MAX), more: ids.length > UNLINKED_MAX };
}

export function conversation(db: Db, messageId: string, options: ConversationOptions = {}): ConversationView {
  const empty: ConversationView = { messages: [], linkedIds: [], pending: false, rootId: null, members: {}, marks: {}, memberCount: 0, unlinkedMore: false };
  const anchor = db.prepare(`SELECT m.channel_id AS channelId, m.ts FROM messages m WHERE m.id = ? AND ${visibleMessageSql('m')}`)
    .get(messageId) as { channelId: string; ts: number } | undefined;
  if (!anchor) return empty;
  const rows = db.prepare(CONVERSATION_SQL).all(messageId) as ConversationLinkRow[];
  const near = [...rows].sort((a, b) => Math.abs(a.ts - anchor.ts) - Math.abs(b.ts - anchor.ts)).slice(0, CONVERSATION_MAX);
  const extra = rows.length ? unlinked(db, rows, near, anchor.ts, options.nearby === true) : { ids: [], more: false };
  const ids = new Set([messageId, ...near.map((r) => r.message_id)]);
  // messagesByIds applies privacy mode; show oldest first.
  const messages = messagesByIds(db, [...ids, ...extra.ids]).sort((a, b) => messageBefore(a, b) ? -1 : messageBefore(b, a) ? 1 : 0);
  const shown = new Set(messages.map((m) => m.id));
  // Every shown message's mark, members or not: a removed message keeps its Undo.
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
    unlinkedMore: extra.more,
  };
}
