// Plans & decisions: Jev spots a plan or a decision in a message; the default AI provider extracts its details.
import { MESSAGE_SEES, defineChannels, definePlugin, definePreference, stringsOr, type JevQueryDecl } from '@plugin-sdk/shared';
import type { PlanItem } from './types';

export const manifest = {
  id: 'plans',
  name: 'Plans & decisions',
  version: '1.0.0',
  description: 'Jev spots plans and decisions in messages; your AI provider extracts the details for the Plans & decisions panel.',
};

export const PLANS_PANEL = 'plans' as const;
/** jev_judgments subject of the plan question. */
export const PLAN_SUBJECT = 'plan';
/** Settings → Jev → Queries id (kept from when it was built in); its ticked options and threshold decide what is extracted. */
export const PLAN_QUERY = 'messages.plans';

/** Core's calls, from the panel. */
export interface PlansCoreCalls {
  /** Plans soonest first (undated after dated), then decisions newest first; privacy mode applies. */
  list(limit: number): PlanItem[];
}

const PLAN_QUERY_DEF: JevQueryDecl<'planDetection'> = {
  id: PLAN_QUERY,
  // Where it was listed when it was built in.
  after: 'messages.tags',
  subject: PLAN_SUBJECT,
  group: 'Messages',
  label: 'Plans and decisions',
  features: ['planDetection'],
  sees: `${MESSAGE_SEES} A hit is sent to your AI provider to extract the details.`,
  use: 'fixed-options',
  condition: 'Extract',
  perMessage: true,
  defaults: {
    type: 'choice',
    question: 'Would the owner want `message` on a list of plans and decisions to look back on? Read `earlier` and `replying_to` only to understand it.',
    options: [
      {
        name: 'plan',
        description: 'a plan worth remembering: someone will do something specific later, such as a meetup, trip, launch or promised task, ideally with a time, place or people',
      },
      { name: 'decision', description: 'a decision that settles what someone or the group will do from now on, stated in the message itself' },
      {
        name: 'neither',
        description:
          'neither: chat, a question, a maybe, a joke, a one-word reply or agreement, a small intention right now ("I\'ll check", "lemme look"), a taste or shopping pick, or something already done',
      },
    ],
    alertOn: ['plan', 'decision'],
    // Each hit is an LLM call; on a real day 0.7 passed 13 of 1,699 messages, nearly all real, and 0.6 added noise.
    minProbability: 0.7,
  },
};

export const plugin = definePlugin({
  manifest,
  channels: defineChannels<{ core: PlansCoreCalls }>()({ core: { list: ['renderer'] } }),
  /** The items listed when the panel was last on screen; null until first stored. */
  preferences: { seen: definePreference<string[] | null>({ default: null, normalize: stringsOr(null) }) },
  // The host's migrations created plans when it was built in; its switch kept its key.
  adopts: { tables: { plans: 'items' }, settings: { 'plans.seen': 'seen' }, jevFeatures: { planDetection: 'planDetection' } },
  panels: [
    {
      id: PLANS_PANEL,
      title: 'Plans & decisions',
      importance: 'secondary',
      dialog: false,
      // A calendar page (the rect as a path: x 4, y 5, 16 × 15, corner 2).
      iconPath: 'M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M4 10h16',
      after: 'chat',
    },
  ],
  jev: { queries: [PLAN_QUERY_DEF], features: [{ key: 'planDetection', label: 'Detect plans and decisions', default: false, after: 'messageTags' }] },
});
export default plugin;
