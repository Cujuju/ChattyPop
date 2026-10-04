// Shared declarations for rule triggers, matches, filters and actions.

/** A stable stored type, editor wording, default configuration and validation. */
export interface RuleKind<C = unknown, T extends string = string> {
  /** Stable stored name; plugin kinds use <plugin id>.<name>. */
  type: T;
  /** Editor placement after another kind type; an unknown anchor appends the kind. */
  after?: string;
  /** Editor placement before another kind type; use one placement direction. */
  before?: string;
  label: string;
  hint: string;
  create(): C;
  /** Throws with a message for the editor. */
  validate(config: C): void;
}

/** Declares whether the trigger supplies a message or a time window. */
export interface RuleTriggerKind<C = unknown, T extends string = string> extends RuleKind<C, T> {
  event: 'message' | 'window';
}

/** An alternative match, optionally contributing the rule’s one Jev question. */
export interface RuleMatchKind<C = unknown, T extends string = string> extends RuleKind<C, T> {
  asksJev: boolean;
}

/** A read-only narrowing condition; all configured filters must hold. */
export interface RuleFilterKind<C = unknown, T extends string = string> extends RuleKind<C, T> {
  /** Whether this configuration narrows archive history; absent uses the host's array/default rule. */
  narrows?(config: C): boolean;
}
/** Execution flags used by validation, scheduling, history and the editor. */
export interface RuleActionKind<C = unknown, T extends string = string> extends RuleKind<C, T> {
  /** Seeds a fresh draft when offered; the first in editor order wins. */
  defaultForNewRule?: boolean;
  /** Window actions cover a stretch of time; message actions receive one matched message. */
  targets: readonly ('message' | 'window')[];
  phase: 'match' | 'after';
  history: boolean;
  minIntervalMs: number | null;
  /** Posts or reacts on Discord as the owner; the rule must opt in. */
  actsAsYou: boolean;
  /** Never acts on a message fetched on catch-up. */
  liveOnly: boolean;
}

/** Declaration type selected by each rule section. */
export interface RuleSections {
  triggers: RuleTriggerKind;
  match: RuleMatchKind;
  filters: RuleFilterKind;
  actions: RuleActionKind;
}
/** Sections a rule kind can belong to. */
export type RuleSection = keyof RuleSections;

/** Defaults for an after-phase message action with no floor or special permissions. */
export const AFTER_MESSAGE = {
  targets: ['message'],
  phase: 'after',
  history: false,
  minIntervalMs: null,
  actsAsYou: false,
  liveOnly: false,
} as const;
