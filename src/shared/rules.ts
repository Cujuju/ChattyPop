// Triggers/gates/matches run rule actions only after arming. Alert actions also show older matches as read history.
import { ruleKind } from './ruleKinds';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from './units';

/** Version of the stored rule JSON (rules.spec); parseRuleSpec upgrades older ones. */
export { RULE_SPEC_VERSION } from './ruleVersion';
import { RULE_SPEC_VERSION } from './ruleVersion';

/** A kind’s stored type and its own configuration. */
export interface RulePart<C = unknown> {
  type: string;
  config: C;
}

/** What starts a rule: a message, a newly applied tag, or a timed window. Tags applied by rules never start rules. */
export type RuleTrigger = RulePart;

/** Which messages a rule may act on at all. Unset lists don't narrow. */
export interface RuleGates {
  guildIds?: string[];
  /** A channel covers its threads. */
  channelIds?: string[];
  authorIds?: string[];
  /** true: authorIds are excluded instead. */
  authorsNot?: boolean;
  /** Also an edited message (still once per message). */
  edits: boolean;
  /** Also messages that arrived while ChattyPop was closed (fetched on catch-up); a live-only plugin action never acts on them. */
  missed: boolean;
}

/** Alternative matches; none means every message passing gates and narrowing. Jev matches require the host message trigger. */
export type RuleMatch = RulePart[];
/** Narrows a match: every configured filter must also hold. */
export type RuleNarrow = RulePart[];

/** What a rule does, in phase and declaration order, once per event; live-only actions skip missed messages. */
export type RuleAction = RulePart & { id: string };

export interface RuleSpec {
  v: typeof RULE_SPEC_VERSION;
  trigger: RuleTrigger;
  gates: RuleGates;
  match: RuleMatch;
  narrow: RuleNarrow;
  actions: RuleAction[];
}

export interface RuleInput {
  name: string;
  enabled: boolean;
  /** The owner's explicit opt-in to this rule posting to Discord as them; required by an action that acts as them. */
  discordSend: boolean;
  spec: RuleSpec;
}

export interface Rule extends RuleInput {
  id: number;
  /** Order rules run in for the same event (all that match run). */
  position: number;
  /** Only messages sent after this act: set when the rule is created or turned back on. */
  armedAt: number;
  createdAt: number;
  /** Set for rules ChattyPop manages (their match is fixed); null = made by the owner. */
  builtin: string | null;
  /** The named group the rules list shows it under; null = ungrouped. Display only: run order is `position`. */
  group: string | null;
  /** Why the rule can't run (e.g. saved by a newer ChattyPop); null when fine. */
  error: string | null;
  fired: number;
  lastFiredAt: number | null;
}

/** One action's result in a run. */
export type RuleOutcome = 'done' | 'skipped' | 'failed';

/** A rule firing on one event, as a rule's activity lists it. */
export interface RuleRun {
  id: number;
  ruleId: number;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  /** Who sent the message and how it began; null when it is no longer archived. */
  authorName: string | null;
  /** How the message began, Discord markup kept (tokens whole); null when it is no longer archived. */
  snippet: string | null;
  /** Display names of the users the message mentions, by id. */
  mentions: Record<string, string>;
  /** false: a backfilled or re-asked message. */
  live: boolean;
  at: number;
  /** `kind`: recordedKind of the action (a plugin action's type). */
  actions: { actionId: string; kind: string; outcome: RuleOutcome; detail: string | null }[];
}

/** Whether an action may act on a fetched message when the rule accepts missed messages. */
export const runsOnMissed = (a: RuleAction): boolean => ruleKind('actions', a.type)?.liveOnly === false;
/** Whether an action needs the rule’s Discord opt-in; an unknown action conservatively counts as acting as the owner. */
export const actsAsYou = (a: RuleAction): boolean => ruleKind('actions', a.type)?.actsAsYou !== false;
/** The stored action type recorded in run activity, including its plugin prefix. */
export const recordedKind = (a: RuleAction): string => a.type;

export { DEFAULT_ACTION_LOOKBACK_MS, ACTION_LOOKBACKS } from './ruleLookback';
/** A plugin action runs at most this often per rule, as a plugin's own schedule (plugins/api.ts MIN_SCHEDULE_MS). */
export const PLUGIN_ACTION_MIN_INTERVAL_MS = MS_PER_MIN;

/** jev_judgments subject for a rule's Jev question. */
export const ruleSubject = (id: number): string => `rule:${id}`;

/** One line naming a rule's actions in order, for lists. */
export const actionsText = (actions: readonly RuleAction[]): string =>
  actions.map((a) => actionInfo(recordedKind(a)).label).join(', ') || 'No actions';

/** Recorded v3 names retain their labels in activity. */
const RECORDED_TYPES: Readonly<Record<string, string>> = {
  notify: 'alerts.notify',
  tag: 'tags.apply',
  summarize: 'summaries.summarize',
  plugin: 'command',
};

/** Labels for recorded kinds: current declarations, legacy v3 names or a missing plugin. */
export function actionInfo(kind: string): { label: string; hint: string } {
  const declaration = ruleKind('actions', RECORDED_TYPES[kind] ?? kind);
  return declaration
    ? { label: declaration.label, hint: declaration.hint }
    : { label: `Plugin action (${kind})`, hint: 'Its plugin is not in this ChattyPop.' };
}
