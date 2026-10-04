// Is a message political, finance or trading? Three independent questions (a message can be several), asked per
// message through the shared request and shown as labels when their condition is met (Settings → Jev → Queries).
import type { Answer } from '../ai/decisions';
import type { TextMessage } from '../arrival';
import { queryRequest, storedMatch } from './queries';
import { registerMessageQuestion } from './messageQuestions';

/** Inline code and code blocks: shell variables there ($PATH) are not tickers. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
/**
 * A cashtag: $ and a 1–5 letter ticker (US exchange symbols' length), with an optional share-class suffix ($BRK.B).
 * Uppercase only, and never after a word character or $, so prices ($100), "US$" and "$$" don't count.
 */
const CASHTAG = /(?<![\w$])\$[A-Z]{1,5}(?:\.[A-Z])?(?![\w])/;
/** Cashtags are how people name a stock they trade, so one settles the trading label. */
const SURE: Answer = { type: 'noul', noul: 1 };

/** Whether a message or the posts it links to name a ticker by cashtag. Residual: a shell variable outside code ($HOME). */
export const hasCashtag = (m: Pick<TextMessage, 'content' | 'linked'>): boolean => CASHTAG.test(`${m.content}\n${m.linked}`.replace(CODE, ''));

export const CLASSES: { subject: string; label: string; query: string; certain?: (m: TextMessage) => Answer | null }[] = [
  { subject: 'class:political', label: 'Political', query: 'messages.classPolitical' },
  { subject: 'class:finance', label: 'Finance', query: 'messages.classFinance' },
  { subject: 'class:trading', label: 'Trading', query: 'messages.classTrading', certain: (m) => (hasCashtag(m) ? SURE : null) },
];

/** Asked for every new message while message classes are on. Call at core init. */
export function registerClasses(): void {
  for (const c of CLASSES) {
    registerMessageQuestion({
      subject: c.subject,
      feature: 'messageClasses',
      question: () => queryRequest(c.query),
      certain: c.certain,
      label: (s) => (storedMatch(c.query, s) ? c.label : null),
    });
  }
}
