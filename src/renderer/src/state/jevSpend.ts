// What Jev has cost (core's ledger, pushed after each burst of requests) and the rate projections use.
import { api } from '@/api';
import { JEV_COST_PER_QUESTION_USD, localDay, recentFromDay, type JevSpend, type JevSpendDay } from '@shared/jevSpend';
import { createPushedValue } from './events';

export const { value: jevSpend } = createPushedValue<JevSpend, 'jev-spend'>(() => api.core.jevSpend(), 'jev-spend', (e) => e.spend);

/** Measured over recent priced requests; the documented rate until there are any. */
export const usdPerQuestion = (): number => jevSpend()?.usdPerQuestion ?? JEV_COST_PER_QUESTION_USD;
export const projectedJevUsd = (questions: number): number => questions * usdPerQuestion();

export interface JevUse {
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

const total = (days: JevSpendDay[]): JevUse =>
  days.reduce((t, d) => ({ usd: t.usd + d.usd, inputTokens: t.inputTokens + d.inputTokens, outputTokens: t.outputTokens + d.outputTokens }), {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
  });

/** Cost and tokens on `now`'s local day. */
export const jevUseToday = (now: number): JevUse => total((jevSpend()?.days ?? []).filter((d) => d.day === localDay(now)));
/** Cost and tokens over the recent window ending on `now`'s day. */
export const jevUseRecent = (now: number): JevUse => {
  const from = recentFromDay(now);
  return total((jevSpend()?.days ?? []).filter((d) => d.day >= from));
};
