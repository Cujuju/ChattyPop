// Links each message to the earlier message it continues, from archive evidence alone (no AI). Pure: the job and the scorer share it.
import { argmax, probabilities, type Weights } from './chooser';
import type { ChooserMessage } from './features';

/** Why a message continues another; `start` begins a conversation. */
export const LINK_KIND = {
  /** A Discord reply. */
  reply: 'reply',
  /** A thread's first message continues the message the thread was started from. */
  thread: 'thread',
  /** An @mention of someone among the recent messages: their latest one. */
  mention: 'mention',
  /** The author's own message just before. */
  continuation: 'continuation',
  /** The chooser's pick among recent messages. */
  inferred: 'inferred',
  /** The chooser's unsure pick, re-ranked with Jev's judgment of each candidate (conversations/judge.ts). */
  judged: 'judged',
  /** The owner's mark in the Conversation view (conversations/marks.ts). */
  owner: 'owner',
  start: 'start',
} as const;
export type LinkKind = (typeof LINK_KIND)[keyof typeof LINK_KIND];

/** Recent messages a message may continue: nine in ten same-channel replies answer one of the last 20. */
export const CANDIDATE_MAX = 20;
/**
 * Below this an inferred link becomes a start. On a 400,000-message archive, the lowest swept level whose largest conversation
 * stayed well under a runaway (149 messages; 0.25 reached 199). Hidden replies: 25% exact (always the previous message: 18%),
 * 41% in the right conversation.
 */
export const LINK_MIN_CONFIDENCE = 0.3;

export interface LinkInput extends ChooserMessage {
  /** The message a Discord reply answers. */
  replyTo: string | null;
  /** Its text, for judgments' freshness (conversations/judge.ts). */
  text: string;
}

/** Re-ranks the chooser's pick: the candidate index and its probability, or null without a current judgment. */
export type Judge = (m: LinkInput, recent: readonly LinkInput[], chooser: Float64Array) => { index: number; probability: number } | null;

export interface Link {
  messageId: string;
  parentId: string | null;
  kind: LinkKind;
  /**
   * The chooser's probability for its best candidate: an inferred link's own; for a start, the link it declined (0 without
   * candidates). 1 for replies and threads.
   */
  confidence: number;
}

export interface LinkContext {
  /** How far back the channel's replies reach (ms): older messages are no candidates. */
  reachMs: number;
  weights: Weights;
  /** Inferred links below this become starts (default LINK_MIN_CONFIDENCE; the scorer sweeps it). */
  minConfidence?: number;
  /** A thread started from a message: its first message and that starter message. */
  thread?: { firstId: string; starterId: string };
  /** The owner's parent; an explicit add moves an outside message even when Discord linked it elsewhere. */
  marked?: (messageId: string) => { parentId: string | null; added?: boolean } | undefined;
  /** Re-ranks picks below JUDGE_BELOW with Jev's stored judgments. */
  judge?: Judge;
}

/** Picks below this the judge may re-rank: on held-out replies the chooser + Jev gained nothing at 0.7 or more (#305). */
export const JUDGE_BELOW = 0.7;

export interface LinkOptions {
  /** Scoring: decide replies as if Discord hadn't marked them, to measure the chooser. */
  hideReplies?: boolean;
}

/** Links `messages` (one channel, time order) after `before` (earlier messages of that channel, time order). */
export function linkMessages(before: readonly LinkInput[], messages: readonly LinkInput[], ctx: LinkContext, options: LinkOptions = {}): Link[] {
  const recent = before.slice(-CANDIDATE_MAX);
  return messages.map((m) => {
    while (recent.length && recent[0]!.ts < m.ts - ctx.reachMs) recent.shift();
    const link = linkOne(m, recent, ctx, options);
    recent.push(m);
    if (recent.length > CANDIDATE_MAX) recent.shift();
    return link;
  });
}

function linkOne(m: LinkInput, recent: readonly LinkInput[], ctx: LinkContext, options: LinkOptions): Link {
  const to = (parentId: string | null, kind: LinkKind, confidence: number): Link => ({ messageId: m.id, parentId, kind, confidence });
  const mark = options.hideReplies ? undefined : ctx.marked?.(m.id);
  if (mark?.added) return to(mark.parentId, LINK_KIND.owner, 1);
  if (m.replyTo && !options.hideReplies) return to(m.replyTo, LINK_KIND.reply, 1);
  if (ctx.thread?.firstId === m.id) return to(ctx.thread.starterId, LINK_KIND.thread, 1);
  if (mark) return to(mark.parentId, LINK_KIND.owner, 1);
  const rule = ruleLink(m, recent);
  if (rule) return to(rule.parentId, rule.kind, 1);
  if (!recent.length) return to(null, LINK_KIND.start, 0);
  const p = probabilities(m, recent, ctx.weights);
  const best = argmax(p);
  if (p[best]! < (ctx.minConfidence ?? LINK_MIN_CONFIDENCE)) return to(null, LINK_KIND.start, p[best]!);
  // Only links the chooser already made are re-ranked: whether a message starts a conversation isn't Jev's to decide yet (#314).
  const judged = p[best]! < JUDGE_BELOW ? ctx.judge?.(m, recent, p) : null;
  return judged ? to(recent[judged.index]!.id, LINK_KIND.judged, judged.probability) : to(recent[best]!.id, LINK_KIND.inferred, p[best]!);
}

/**
 * Evidence the chooser cannot learn from replies, so rules decide it: a reply's ping is not in its text, and nobody
 * reply-marks their own message. The chooser is fitted only where these don't apply.
 */
export function ruleLink(m: ChooserMessage, recent: readonly ChooserMessage[]): { parentId: string; kind: LinkKind } | null {
  for (const user of m.mentions) {
    const spoke = findLast(recent, (r) => r.authorId === user && user !== m.authorId);
    if (spoke) return { parentId: spoke.id, kind: LINK_KIND.mention };
  }
  const previous = recent.at(-1);
  return previous?.authorId === m.authorId ? { parentId: previous.id, kind: LINK_KIND.continuation } : null;
}

const findLast = <T,>(items: readonly T[], match: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i];
  return undefined;
};
