// AI results and status: provider and plan usage, Jev answers.
import type { JevConnection, ProviderId } from '../settings';
import type { JevQuestionSpec } from '../jevQuestion';

/** Tokens a provider reported for AI calls. Input includes cached input. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** What ChattyPop itself consumed: AI runs and their summed tokens. */
export interface AppUsage extends TokenUsage {
  runs: number;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Thinking/effort levels the model accepts, in the provider's own names; absent = none to choose. */
  efforts?: string[];
  /** The model a null model setting resolves to. */
  isDefault?: boolean;
  /** It reads images sent with a prompt (a provider declared with `images`). */
  images?: boolean;
  /** Its size on disk, for a model installed on this computer. */
  bytes?: number;
}

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
  detail: string;
  /** Models the provider offers; null when it couldn't be listed (see detail). */
  models: ModelOption[] | null;
}

/** One plan rate-limit window, normalized across providers. */
export interface PlanUsageWindow {
  id: string;
  label: string;
  /** 0–100, or null when the provider doesn't report it. */
  usedPercent: number | null;
  /** ISO-8601 reset time, or null. */
  resetsAt: string | null;
  /** Window length; with resetsAt it gives the window start. Null when unknown. */
  durationMs: number | null;
  /** Extra reading, e.g. credits left. */
  note?: string;
}

/** Jev's answers about one message; value is a probability (noul, choice) or a level (score). */
export interface JevCheckResult {
  checks: { id: string; label: string; kind: JevQuestionSpec['type']; value: number; choice: string | null }[];
  costUsd: number | null;
}

/** Custom Jev call: the owner's question about each of a channel's latest messages. */
export interface JevRangeAsk {
  channelId: string;
  question: JevQuestionSpec;
  /** How many of the latest messages to ask about. */
  limit: number;
}

export interface JevAskResult {
  kind: JevQuestionSpec['type'];
  /** Highest value first: a probability (yes/no, pick-one) or a level (score) per message, with the chosen option for pick-one. */
  results: { messageId: string; channelId: string; ts: number; content: string; value: number; choice: string | null }[];
  asked: number;
  failed: number;
  costUsd: number | null;
}

/** Jev (decision model) readiness for Settings. */
export interface JevStatus {
  /** The chosen connection has a key: an OpenRouter key that lists Jev, or a TypeSafe key. */
  available: boolean;
  connection: JevConnection;
  model: string;
  /** Who pays for Jev on the chosen connection (an OpenRouter key's name, or "TypeSafe"); null when nobody does. */
  keyLabel: string | null;
  /** Last characters of the stored TypeSafe key; null when none is stored. */
  typeSafeKeyHint: string | null;
  /** Most recent failed request this session; cleared by the next success. */
  lastError: { message: string; at: number } | null;
}
