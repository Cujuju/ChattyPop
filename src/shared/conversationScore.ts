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

/** Jev against the chooser on held-out replies whose chooser confidence was in [from, to): picks that were the reply's target. */
export interface JevBucketScore {
  from: number;
  to: number;
  asked: number;
  /** Jev answered every question. */
  answered: number;
  chooserExact: number;
  /** The candidate Jev's Scores rated highest. */
  relatesExact: number;
  /** The chooser and Jev's Scores combined, weighted by a fit on the other half of the cases. */
  combinedExact: number;
  /** Jev said the reply responds to something earlier (at least even odds): every case here does. */
  respondsYes: number;
}

/** Answered cases whose highest-rated candidate's top-level probability was in [from, to), and how many of those were right. */
export interface JevConfidenceScore {
  from: number;
  to: number;
  asked: number;
  exact: number;
}

export interface JevLinkScore {
  /** The Jev release asked. */
  model: string;
  bands: JevBucketScore[];
  byJevConfidence: JevConfidenceScore[];
  /** The combination fitted on every answered case: weights on the chooser's log probability, the Score position's log-odds and the top level's log probability. */
  combinedWeights: Record<string, number>;
  failed: number;
  /** The first failed request's error: other Jev features' successes clear Settings' last error. */
  failure: string | null;
  /** Held-out replies skipped because their target wasn't among the candidates. */
  outOfReach: number;
  costUsd: number | null;
}
