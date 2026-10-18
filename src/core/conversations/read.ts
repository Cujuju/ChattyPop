// Reads one message's conversation from stored links, privacy applied: the host's Conversation view and plugins (ctx.archive.conversationSql) share it.

/** Links followed up to the root: deeper than any linked conversation measured (largest: 149 messages). */
export const CONVERSATION_HOPS_MAX = 200;
/** Messages a read visits below the root, breadth first: a thread joined to its starter can't make one read walk it all. */
export const CONVERSATION_SCAN_MAX = 800;

/**
 * The conversation of the message bound to its one parameter: `message_id, channel_id, ts, parent_id, kind, confidence`
 * for each linked message from the root down, in visit order. Reads archive_conversation_links, so a hidden message or
 * parent ends the walk there. A message not linked yet returns nothing.
 */
export const CONVERSATION_SQL = `WITH RECURSIVE
  up(id, hops) AS (SELECT ?, 0 UNION ALL SELECT l.parent_id, up.hops + 1 FROM up JOIN archive_conversation_links l ON l.message_id = up.id
    WHERE l.parent_id IS NOT NULL AND up.hops < ${CONVERSATION_HOPS_MAX}),
  root(id) AS (SELECT id FROM up ORDER BY hops DESC LIMIT 1),
  down(id) AS (SELECT id FROM root UNION SELECT l.message_id FROM down JOIN archive_conversation_links l ON l.parent_id = down.id
    LIMIT ${CONVERSATION_SCAN_MAX})
  SELECT l.message_id, l.channel_id, l.ts, l.parent_id, l.kind, l.confidence FROM down JOIN archive_conversation_links l ON l.message_id = down.id`;

export interface ConversationLinkRow {
  message_id: string;
  channel_id: string;
  ts: number;
  parent_id: string | null;
  kind: string;
  confidence: number;
}

