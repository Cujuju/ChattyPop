// Links each message to the earlier message it continues, from archive evidence alone (no AI). Pure: the job and the scorer share it.

/** Why a message continues another, strongest evidence first; `start` begins a conversation. */
export const LINK_KIND = {
  /** A Discord reply. */
  reply: 'reply',
  /** A thread's first message continues the message the thread was started from. */
  thread: 'thread',
  /** An @mention of someone who spoke within the channel's gap. */
  mention: 'mention',
  /** The author's own message immediately before. */
  continuation: 'continuation',
  /** Answers the other person in a back-and-forth: this author spoke just before their latest messages. */
  exchange: 'exchange',
  /** Only the previous message being recent: weak evidence, kept for a later judge. */
  adjacent: 'adjacent',
  start: 'start',
} as const;
export type LinkKind = (typeof LINK_KIND)[keyof typeof LINK_KIND];

export interface LinkInput {
  id: string;
  authorId: string;
  ts: number;
  /** The message a Discord reply answers. */
  replyTo: string | null;
  /** Users @mentioned in the text, in order. */
  mentions: readonly string[];
}

export interface Link {
  messageId: string;
  parentId: string | null;
  kind: LinkKind;
}

export interface LinkContext {
  /** How long the channel's conversations wait for an answer (ms). */
  gapMs: number;
  /** A thread started from a message: its first message and that starter message. */
  thread?: { firstId: string; starterId: string };
}

export interface LinkOptions {
  /** Scoring: decide replies as if Discord hadn't marked them, to measure the other evidence. */
  hideReplies?: boolean;
}

/** Links `messages` (one channel, time order) after `before` (earlier messages of that channel, time order). */
export function linkMessages(before: readonly LinkInput[], messages: readonly LinkInput[], ctx: LinkContext, options: LinkOptions = {}): Link[] {
  const recent = [...before];
  return messages.map((m) => {
    while (recent.length && recent[0]!.ts < m.ts - ctx.gapMs) recent.shift();
    const link = linkOne(m, recent, ctx, options);
    recent.push(m);
    return link;
  });
}

function linkOne(m: LinkInput, recent: readonly LinkInput[], ctx: LinkContext, options: LinkOptions): Link {
  const to = (parentId: string | null, kind: LinkKind): Link => ({ messageId: m.id, parentId, kind });
  if (m.replyTo && !options.hideReplies) return to(m.replyTo, LINK_KIND.reply);
  if (ctx.thread?.firstId === m.id) return to(ctx.thread.starterId, LINK_KIND.thread);
  for (const user of m.mentions) {
    const spoke = findLast(recent, (r) => r.authorId === user && user !== m.authorId);
    if (spoke) return to(spoke.id, LINK_KIND.mention);
  }
  const previous = recent.at(-1);
  if (!previous) return to(null, LINK_KIND.start);
  if (previous.authorId === m.authorId) return to(previous.id, LINK_KIND.continuation);
  // Back-and-forth: before the other person's latest run of messages, this author spoke.
  let i = recent.length - 1;
  while (i >= 0 && recent[i]!.authorId === previous.authorId) i--;
  if (i >= 0 && recent[i]!.authorId === m.authorId) return to(previous.id, LINK_KIND.exchange);
  return to(previous.id, LINK_KIND.adjacent);
}

const findLast = <T,>(items: readonly T[], match: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i];
  return undefined;
};
