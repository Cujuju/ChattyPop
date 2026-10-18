// Scores the rules without labels: each Discord reply is decided as if unmarked, and the choice is compared with what it answered.
import type { KindScore, LinkScore } from '@shared/conversationScore';
import type { Db } from '../db';
import { LINK_KIND, linkMessages, type LinkKind } from './linker';
import { CONTEXT_MAX, LINK_BATCH } from './job';
import { channelGap, contextInputs, linkInputs, threadStart } from './store';

const emptyKinds = (): Record<LinkKind, KindScore> =>
  Object.fromEntries(Object.values(LINK_KIND).map((k) => [k, { replies: 0, exact: 0, sameConversation: 0 }])) as Record<LinkKind, KindScore>;

/** Scores `channelIds` (default: every archived channel), yielding between batches. */
export async function scoreReplyHoldout(db: Db, channelIds?: readonly string[], signal?: AbortSignal): Promise<LinkScore> {
  const score: LinkScore = { replies: 0, exact: 0, sameConversation: 0, byKind: emptyKinds(), previousExact: 0, stored: {}, queuedChannels: 0 };
  const channels = channelIds ?? (db.prepare('SELECT DISTINCT channel_id FROM messages').pluck().all() as string[]);
  for (const channelId of channels) await scoreChannel(db, channelId, score, signal);
  for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM conversation_links GROUP BY kind').all() as { kind: string; n: number }[]) score.stored[row.kind] = row.n;
  score.queuedChannels = db.prepare('SELECT COUNT(*) FROM conversation_link_queue').pluck().get() as number;
  return score;
}

async function scoreChannel(db: Db, channelId: string, score: LinkScore, signal?: AbortSignal): Promise<void> {
  const gapMs = channelGap(db, channelId);
  const thread = threadStart(db, channelId);
  const storedParent = db.prepare('SELECT parent_id FROM conversation_links WHERE message_id = ?').pluck();
  /** Each seen message's conversation, by its root message. */
  const root = new Map<string, string>();
  let cursor = { ts: Number.MIN_SAFE_INTEGER, id: '' };
  let context = contextInputs(db, channelId, cursor, gapMs, CONTEXT_MAX);
  for (;;) {
    signal?.throwIfAborted();
    const batch = linkInputs(db, channelId, cursor, Number.MAX_SAFE_INTEGER, LINK_BATCH);
    if (!batch.length) return;
    const held = linkMessages(context, batch, { gapMs, ...(thread ? { thread } : {}) }, { hideReplies: true });
    batch.forEach((m, i) => {
      const parent = storedParent.get(m.id) as string | null | undefined;
      root.set(m.id, parent ? root.get(parent) ?? parent : m.id);
      if (!m.replyTo || !root.has(m.replyTo) || m.replyTo === m.id) return;
      const chosen = held[i]!;
      const kind = score.byKind[chosen.kind]!;
      const exact = chosen.parentId === m.replyTo;
      const same = chosen.parentId !== null && root.get(chosen.parentId) === root.get(m.replyTo);
      score.replies++;
      kind.replies++;
      if (exact) { score.exact++; kind.exact++; }
      if (same) { score.sameConversation++; kind.sameConversation++; }
      const previous = i > 0 ? batch[i - 1] : context.at(-1);
      if (previous?.id === m.replyTo) score.previousExact++;
    });
    context = [...context, ...batch].slice(-CONTEXT_MAX);
    cursor = { ts: batch.at(-1)!.ts, id: batch.at(-1)!.id };
    await new Promise((resolve) => setImmediate(resolve));
  }
}
