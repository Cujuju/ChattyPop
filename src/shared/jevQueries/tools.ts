// Built-in Jev queries for channel suggestions and the Jev check.
import type { JevQueryDef } from './index';
import { CONTEXT_NOTE } from './messages';

const CHECK_SEES = '`message` (author: text), `earlier` (the two messages before it) and `replying_to`. Asked only when you right-click → Jev check.';

const check = (id: string, label: string, question: string): JevQueryDef => ({
  id,
  group: 'Jev check',
  label,
  features: ['messageCheck'],
  sees: CHECK_SEES,
  use: 'display',
  condition: null,
  defaults: { type: 'noul', question: `${question} ${CONTEXT_NOTE}`, yes: '', no: '', minProbability: 0.5 },
});

export const TOOL_QUERIES: readonly JevQueryDef[] = [
  {
    id: 'channels.suggest',
    group: 'Links & search',
    label: 'Channel fits a topic',
    features: ['suggestChannels'],
    sees: '`channel` (its name) and `recent` (a sample of its latest messages).',
    vars: ['`topic`: a topic’s description, else its name'],
    use: 'decision',
    condition: 'Suggest the channel',
    defaults: {
      type: 'noul',
      question: 'Judging by `recent`, does this channel regularly discuss `topic`?',
      yes: 'the topic comes up regularly here',
      no: 'it does not, or only in passing',
      // A suggestion should be a clear fit, not a maybe.
      minProbability: 0.6,
    },
  },
  check('check.trolling', 'Trolling / baiting', 'Is `message` trying to provoke or bait others into a reaction rather than to communicate?'),
  check('check.manipulation', 'Manipulative persuasion', 'Does `message` try to persuade through pressure, guilt, flattery or deception rather than reasons?'),
  check('check.coordination', 'Deceptive coordination', 'Does `message` coordinate others to deceive, brigade, spam or mass-report?'),
  check('check.humor', 'Joke, sarcasm or quotation', 'Is `message` a joke, sarcasm or a quotation rather than its author’s sincere statement?'),
  check('check.context', 'Needs more context', 'Would a reader need more context than `earlier` and `replying_to` to judge `message` fairly?'),
];
