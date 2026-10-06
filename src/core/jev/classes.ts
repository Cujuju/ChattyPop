// Independent political, finance and trading questions share message requests. Multiple labels may apply; query settings control display conditions.
import type { Answer } from '../ai/decisions';
import type { TextMessage } from '../arrival';
import { queryRequest, storedMatch } from './queries';
import { registerMessageQuestion } from './messageQuestions';

/** Inline code and code blocks: shell variables there ($PATH) are not tickers. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
/** Uppercase cashtags have 1–5 letters and optional share-class suffix. Rejects prices and prefixes following word characters or $. */
const CASHTAG = /(?<![\w$])\$[A-Z]{1,5}(?:\.[A-Z])?(?![\w])/;
/** Cashtags are how people name a stock they trade, so one settles the trading label. */
const SURE: Answer = { type: 'noul', noul: 1 };

/** Checks message/linked text for cashtags. Shell variables outside code can match. */
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
