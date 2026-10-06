// Per-message one-of auto-tags share Jev requests. Query settings edit options and which choices display as tags.
import { queryRequest, storedMatch } from './queries';
import { registerMessageQuestion } from './messageQuestions';

export const TAG_SUBJECT = 'tag';
export const TAG_QUERY = 'messages.tags';

/** Asked for every new message while Settings → Jev → message tags is on. Call at core init. */
export function registerTags(): void {
  registerMessageQuestion({
    subject: TAG_SUBJECT,
    feature: 'messageTags',
    question: () => queryRequest(TAG_QUERY),
    label: (s) => (s.label && storedMatch(TAG_QUERY, s) ? s.label : null),
  });
}
