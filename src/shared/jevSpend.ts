// What Jev has cost: every request's reported price, kept per local day, and the rate projections are made from.

/**
 * Fallback rate before any priced request is on record: measured Sept 2026 at ~$0.000015 per question per message
 * (yes/no or pick one alike).
 */
export const JEV_COST_PER_QUESTION_USD = 0.000015;
/** Days the status bar's "recent" spend covers; the measured rate is taken over the same window, so price changes show. */
export const JEV_SPEND_RECENT_DAYS = 30;

export interface JevSpendDay {
  /** Local date, YYYY-MM-DD. */
  day: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevSpend {
  /** Spend per local day over the last JEV_SPEND_RECENT_DAYS days, oldest first; days without requests are absent. */
  days: JevSpendDay[];
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Requests answered without token counts (all of them before tokens were recorded); not in the token totals. */
  tokenlessRequests: number;
  /** Requests the service answered without a price; not in the totals. */
  unpricedRequests: number;
  /** Average cost per question over the recent window's priced requests; null before any. */
  usdPerQuestion: number | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local YYYY-MM-DD for a time: the ledger's day key. */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The first local day of the recent window ending on `now`'s day. */
export const recentFromDay = (now: number): string => {
  const d = new Date(now);
  d.setDate(d.getDate() - (JEV_SPEND_RECENT_DAYS - 1));
  return localDay(d.getTime());
};
