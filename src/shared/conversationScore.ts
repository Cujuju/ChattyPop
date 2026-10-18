// How well conversation links recover Discord replies decided as if unmarked (src/core/conversations/score.ts).

export interface KindScore {
  /** Held-out replies the rules linked by this kind. */
  replies: number;
  /** ...to the message the reply answered. */
  exact: number;
  /** ...to a message in that message's conversation (by stored links). */
  sameConversation: number;
}

export interface LinkScore {
  /** Discord replies to earlier messages of their own channel, decided with the reply hidden. */
  replies: number;
  exact: number;
  sameConversation: number;
  /** By the link kind the rules chose. */
  byKind: Record<string, KindScore>;
  /** Baseline: always choosing the previous message. */
  previousExact: number;
  /** Every stored link, by kind: how much each rule decides. */
  stored: Record<string, number>;
  /** Channels still queued: their stored links (and sameConversation) may be stale. */
  queuedChannels: number;
}
