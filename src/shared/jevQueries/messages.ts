// Built-in per-message Jev queries: notable, classes and tags; plans are the plans plugin's. Defaults are the tuned originals.
import type { JevQueryDef } from './index';

/** What a per-message query sees; shared with alerts.ts. */
export const MESSAGE_SEES = '`message` (author: text, then the text of any post it links to), `earlier` (the two messages before it) and `replying_to` (what it replies to, if anything).';
/** Appended to per-message questions; shared with tools.ts (Jev check). */
export const CONTEXT_NOTE ='Read `earlier` and `replying_to` only to understand `message`.';
/** From real data (Sept 2026, 1,700 messages): every wrong class label scored below 0.9, most right ones above. */
const CLASS_AT = 0.9;

const classQuery = (id: string, label: string, question: string, yes: string, no: string): JevQueryDef => ({
  id,
  group: 'Messages',
  label,
  features: ['messageClasses'],
  sees: MESSAGE_SEES,
  use: 'decision',
  condition: 'Show the label',
  perMessage: true,
  defaults: { type: 'noul', question: `${question} ${CONTEXT_NOTE}`, yes, no, minProbability: CLASS_AT },
});

export const MESSAGE_QUERIES: readonly JevQueryDef[] = [
  {
    id: 'messages.notable',
    group: 'Messages',
    label: 'Notable message',
    features: ['catchUpBadges', 'keepImportant'],
    sees: `${MESSAGE_SEES} Used by catch-up badges and keep-notable text retention.`,
    use: 'decision',
    condition: 'Count as notable',
    perMessage: true,
    defaults: {
      type: 'noul',
      question: 'Does `message` carry information someone catching up on this chat would need? Read `earlier` and `replying_to` only to understand it.',
      yes: 'It states a fact, decision, plan, question, answer, request, opinion or link that matters.',
      no: 'It adds nothing needed: a greeting, reaction, emoji, laugh or acknowledgement.',
      // Precision: a badge that cries wolf gets ignored.
      minProbability: 0.7,
    },
  },
  classQuery(
    'messages.classPolitical',
    'Political label',
    'Is `message` about politics: government, elections, politicians, parties, policy or political ideology?',
    '`message` discusses a political subject.',
    '`message` is about something else, even if a politician is only named in passing.',
  ),
  classQuery(
    'messages.classFinance',
    'Finance label',
    'Is `message` about money matters: personal finance, banking, taxes, loans, mortgages, prices, salaries or the economy?',
    '`message` discusses a finance subject.',
    '`message` is about something else.',
  ),
  classQuery(
    'messages.classTrading',
    'Trading label',
    'Is `message` about trading or investing: stocks, options, futures, crypto, forex, positions, trades or market moves?',
    '`message` discusses trading or investing.',
    '`message` is about something else.',
  ),
  {
    id: 'messages.tags',
    group: 'Messages',
    label: 'Message tags',
    features: ['messageTags'],
    sees: MESSAGE_SEES,
    use: 'labels',
    condition: 'Show as a tag',
    perMessage: true,
    defaults: {
      type: 'choice',
      question: 'What is `message` mainly? Read `earlier` and `replying_to` only to understand it.',
      options: [
        { name: 'announcement', description: 'an announcement: news or information shared for everyone' },
        { name: 'decision', description: 'a decision someone made or the group agreed on' },
        { name: 'plan', description: 'a plan: something someone will do, often with a time or place' },
        { name: 'question', description: 'a question someone asks' },
        { name: 'none', description: 'none of these: chat, a reaction, a joke or an answer' },
      ],
      alertOn: ['announcement', 'decision', 'plan', 'question'],
      // A wrong label misleads more than a missing one.
      minProbability: 0.6,
    },
  },
  {
    id: 'conversations.responds',
    group: 'Messages',
    label: 'Whether it answers something earlier',
    features: ['linkConversations'],
    sees: '`message` alone (`from`, `text`). Asked only when the app is unsure.',
    use: 'rank',
    condition: null,
    defaults: {
      type: 'noul',
      question: 'Does `message` respond to something said before it in the chat, rather than start a subject of its own?',
      yes: '`message` answers, reacts to or follows up on an earlier remark; read alone, it presupposes that remark.',
      no: '`message` opens a subject, greets, or is a standalone remark that needs no earlier message.',
      // Unused: the app weighs the answer with the chooser (condition null).
      minProbability: 0.5,
    },
  },
  {
    id: 'conversations.relates',
    group: 'Messages',
    label: 'How it relates to one earlier message',
    features: ['linkConversations'],
    sees: '`message` and `earlier_message` (each `from`, `text`): asked once for each of the channel’s messages just before it, each on its own. Asked only when the app is unsure.',
    use: 'fixed-levels',
    condition: null,
    defaults: {
      type: 'score',
      question: '`earlier_message` was posted before `message` in the same channel. How does `message` relate to it?',
      levels: [
        '`message` is about something else.',
        '`message` is on the same subject as `earlier_message` but does not respond to it.',
        '`message` responds to `earlier_message` itself: it answers it, reacts to it, or follows up on what it says.',
      ],
      // Unused: the app ranks candidates by the answer (condition null).
      minScore: 2,
    },
  },
];
