// The owner's marks in the Conversation view: they set a message's link (kind `owner`) and are kept, with their history, as training data.
import type { ConversationMark } from '@shared/types/archive';
import { messageBefore as before } from '@shared/messageOrder';
import { visibleMessageSql } from '../queries/privacy';
import type { Db } from '../db';
import { argmax, probabilities } from './chooser';
import { chooserWeights } from './fit';
import { LINKER_VERSION } from './job';
import { CANDIDATE_MAX, LINK_KIND } from './linker';
import { CONVERSATION_SQL, type ConversationLinkRow } from './read';
import { channelReach, contextInputs, messageInput, queueConversationLinks } from './store';

export type { ConversationMark };

/** Each marked message's parent (null: it starts a conversation), for the linker. */
export function markedLinks(db: Db): (messageId: string) => { parentId: string | null; added: boolean } | undefined {
  const get = db.prepare('SELECT parent_id AS parentId, mark FROM conversation_marks WHERE message_id = ?');
  return (id) => {
    const row = get.get(id) as { parentId: string | null; mark: ConversationMark } | undefined;
    return row && { parentId: row.parentId, added: row.mark === 'add' };
  };
}

interface Placed { id: string; channelId: string; ts: number }

function visible(db: Db, id: string): Placed {
  const m = db.prepare(`SELECT m.id, m.channel_id AS channelId, m.ts FROM messages m WHERE m.id = ? AND ${visibleMessageSql('m')}`).get(id) as Placed | undefined;
  if (!m) throw new Error('That message isn’t in the archive, or privacy mode hides it.');
  return m;
}

/** A conversation's visible members, root first. */
const members = (db: Db, anchorId: string): ConversationLinkRow[] => db.prepare(CONVERSATION_SQL).all(anchorId) as ConversationLinkRow[];

/** The member of the conversation `x` most likely continues: the chooser's best member among x's candidates, else the latest member before it. */
function memberParent(db: Db, x: Placed, rows: readonly ConversationLinkRow[]): string {
  const ids = new Set(rows.map((r) => r.message_id));
  const m = messageInput(db, x.id);
  const candidates = m ? contextInputs(db, x.channelId, m, channelReach(db, x.channelId), CANDIDATE_MAX) : [];
  if (m && candidates.some((c) => ids.has(c.id))) {
    const p = probabilities(m, candidates, chooserWeights(db, LINKER_VERSION));
    return candidates[argmax(candidates.map((c, j) => (ids.has(c.id) ? p[j]! : -1)))]!.id;
  }
  const earlier = rows.filter((r) => r.channel_id === x.channelId && before({ id: r.message_id, ts: r.ts }, x));
  const latest = earlier.reduce<ConversationLinkRow | null>((a, r) => (!a || before({ id: a.message_id, ts: a.ts }, { id: r.message_id, ts: r.ts }) ? r : a), null);
  if (!latest) throw new Error('Only a message after the conversation’s first one can be added.');
  return latest.message_id;
}

/**
 * Marks `messageId` in the conversation of `conversationOf` (null clears its mark): `belongs` keeps its link, `not` makes it
 * start its own (messages continuing it go with it), `add` links a message outside to the conversation. Relinks from it.
 */
export function markConversation(db: Db, messageId: string, conversationOf: string, mark: ConversationMark | null): void {
  const x = visible(db, messageId);
  visible(db, conversationOf);
  const link = db.prepare('SELECT parent_id AS parentId, kind FROM conversation_links WHERE message_id = ?').get(x.id) as { parentId: string | null; kind: string } | undefined;
  const added = db.prepare("SELECT 1 FROM conversation_marks WHERE message_id = ? AND mark = 'add'").get(x.id) !== undefined;
  if ((link?.kind === LINK_KIND.reply || link?.kind === LINK_KIND.thread) && mark !== 'add' && !(mark === null && added)) {
    throw new Error('Discord linked this message itself, so it can’t be changed here.');
  }
  const rows = members(db, conversationOf);
  const member = rows.some((r) => r.message_id === x.id);
  const root = rows[0];
  let parentId: string | null = null;
  if (mark === 'belongs' || mark === 'not') {
    if (!member) throw new Error('That message isn’t in this conversation.');
    if (root?.message_id === x.id) throw new Error('That message starts this conversation.');
    if (mark === 'belongs') parentId = link?.parentId ?? null;
  } else if (mark === 'add') {
    if (member) throw new Error('That message is already in this conversation.');
    if (!root || root.channel_id !== x.channelId || !before({ id: root.message_id, ts: root.ts }, x)) {
      throw new Error('Only a later message of the same channel can be added.');
    }
    parentId = memberParent(db, x, rows);
  }
  const now = Date.now();
  db.transaction(() => {
    if (mark) {
      db.prepare('INSERT OR REPLACE INTO conversation_marks (message_id, channel_id, mark, parent_id, conversation_of, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(x.id, x.channelId, mark, parentId, conversationOf, now);
    } else db.prepare('DELETE FROM conversation_marks WHERE message_id = ?').run(x.id);
    db.prepare('INSERT INTO conversation_mark_log (message_id, mark, parent_id, replaced_parent_id, conversation_of, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(x.id, mark, parentId, link?.parentId ?? null, conversationOf, now);
    queueConversationLinks(db, x.channelId, x.ts);
  })();
}
