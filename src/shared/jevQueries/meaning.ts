// Built-in Jev queries behind alerts. Defaults are the tuned originals (see each cut-off's note).
import type { JevQueryDef } from './index';
import { MESSAGE_SEES } from './messages';

/** Built-in alert cut-offs start at 0.7: precision first, since a false alert costs attention. */
const ALERT_AT = 0.7;

export const MEANING_QUERIES: readonly JevQueryDef[] = [
  {
    id: 'rules.meaning',
    group: 'Alerts',
    label: 'Rule by meaning',
    features: ['topicMeaning'],
    sees: `${MESSAGE_SEES} Asked once per rule by meaning.`,
    vars: ['`topic`: the subject the rule describes'],
    use: 'decision',
    condition: 'Alert',
    perMessage: true,
    defaults: {
      type: 'noul',
      question: 'Is `message` about `topic`? Read `earlier` and `replying_to` only to understand what `message` refers to.',
      yes: '`message` itself discusses `topic`.',
      no: '`message` is about something else. `topic` appearing only in `earlier` or `replying_to` does not count.',
      minProbability: ALERT_AT,
    },
  },
];
