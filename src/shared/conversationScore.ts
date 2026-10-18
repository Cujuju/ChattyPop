// How well conversation links recover Discord replies decided as if unmarked (src/core/conversations/score.ts).

/** Conversations by links: messages per conversation. */
export interface ConversationSizes {
  count: number;
  median: number;
  p90: number;
  max: number;
  /** Messages in runaway conversations (score.ts RUNAWAY_CONVERSATION or more messages). */
  inRunaway: number;
}

/** The outcome had inferred links been kept only at or above `minConfidence`. */
export interface LevelScore {
  minConfidence: number;
  /** Held-out replies linked to the message they answered. */
  exact: number;
  /** ...to a message in that message's conversation. */
  sameConversation: number;
  conversations: ConversationSizes;
}

export interface LinkScore {
  /** Held-out Discord replies to earlier messages of their own channel, decided with the reply hidden. */
  replies: number;
  /** Baseline: always choosing the previous message. */
  previousExact: number;
  /** Archived messages scored. */
  messages: number;
  /** The level linking uses now, and each compared level. */
  minConfidence: number;
  levels: LevelScore[];
  /** The chooser fitted on the other half of the replies: its examples and weights by feature. */
  fit: { samples: number; weights: Record<string, number> };
  /** Every stored link, by kind. */
  stored: Record<string, number>;
  /** Channels still queued for linking. */
  queuedChannels: number;
}
