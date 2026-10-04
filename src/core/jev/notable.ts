// Catch-up badges and keep important: Jev's per-message "notable" judgment, asked once and shared.
import { queryRequest } from './queries';
import { registerMessageQuestion } from './messageQuestions';

export const NOTABLE_SUBJECT = 'notable';
/** Settings → Jev → Queries id; its condition decides what counts as notable. */
export const NOTABLE_QUERY = 'messages.notable';

/** Asked for every new message while catch-up badges or keep-important is on. Call at core init. */
export function registerNotable(): void {
  registerMessageQuestion({ subject: NOTABLE_SUBJECT, feature: ['catchUpBadges', 'keepImportant'], question: () => queryRequest(NOTABLE_QUERY) });
}
