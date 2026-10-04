// Core registrations for rule kinds, lifecycle listeners and trigger dispatch.
import { AsyncLocalStorage } from 'node:async_hooks';
import { NONE_STARTED, kindUnavailable, type PluginStates } from '@shared/ruleAvailability';
import { HOST } from '@shared/ruleKinds/catalog';
import { ruleKind, type RuleKindLookup } from '@shared/ruleKinds';
import { validateActionInterval } from '@shared/ruleKinds/intervals';
import type { RawUser } from '@shared/discord';
import type { PluginRange } from '@shared/plugins';
import type { RulePart, RuleSpec } from '@shared/rules';
import type { TimedState, TimedTriggerKind } from '@shared/ruleTime';
import type { LiveAt, TextMessage } from '../arrival';
import type { Hit } from './hit';
import type { Answers } from '../jev/messageJudge';
import type { RuleQuestion } from '../jev/questions';
import type { RuleHistory } from './history';
import type { ManagedRule } from './managed';
import type { MessageFacts } from './compile';
import type { ActionResult } from './actions';

/** The rule identity and permissions visible to kind implementations, without its mutable stored configuration. */
export interface RuleRef {
  id: number;
  name: string;
  managed: string | null;
  armedAt: number;
  discordSend: boolean;
}

/** A message match with an explicit host event id shared by its actions and settlement. */
export interface MessageEvent {
  kind: 'message';
  eventId: number;
  m: TextMessage;
  live: boolean;
  liveAt: LiveAt;
  hit: Hit;
}

/** A due schedule’s time span, channel scope and timing label. */
export interface WindowEvent {
  kind: 'window';
  range: PluginRange;
  timing: TimedTriggerKind;
}

/** One action invocation; history has no run id and produces no recorded outcome. */
export interface ActionRun {
  rule: RuleRef;
  actionId: string;
  runId: number | null;
  history: boolean;
  event: MessageEvent | WindowEvent;
}

/** The matched message, cached facts, rule identity and currently known owner. */
export interface MatchContext {
  m: TextMessage;
  facts: MessageFacts;
  rule: RuleRef;
  self: RawUser | null;
}

/** The message and cached reads available to synchronous narrowing filters. */
export interface FilterContext {
  m: TextMessage;
  facts: MessageFacts;
}

/** Direct and Jev matching callbacks; prepare runs once per rule compilation. */
export interface MatchImpl<C = unknown, P = C> {
  prepare?(config: C): P;
  direct?(config: P, c: MatchContext): Hit | null;
  question?(config: P, c: MatchContext): RuleQuestion | null;
}

/** A synchronous filter with optional configuration preparation at compilation. */
export interface FilterImpl<C = unknown, P = C> {
  prepare?(config: C): P;
  test(config: P, c: FilterContext): boolean;
}

/** A message trigger’s payload, deduplication key and configuration acceptance test. */
export interface TriggerEvent {
  m: TextMessage;
  liveAt: LiveAt;
  key: string;
  accepts(config: unknown): boolean;
}

/** The rule changed or was deleted; owners can invalidate rule-specific state. */
export interface RuleEdited {
  ruleId: number;
  matchChanged: boolean;
  deleted: boolean;
  /** The rule's spec after the edit; null when deleted or unreadable. */
  spec: RuleSpec | null;
}

/** Host storage behind managed rules, bound by the rule service. */
export interface ManagedStore {
  /** Creates, switches and re-arms the listed rules; true when any changed. */
  sync(list: ManagedRule[]): boolean;
  /** The id of the rule stored under a managed key, or null. */
  ruleId(key: string): number | null;
}

/** One completed message event; answers are null when no request was made or it failed. */
export interface Settled {
  eventId: number;
  m: TextMessage;
  answers: Answers | null;
}

/** The due window’s run key, lower time bound and trigger timing label. */
export interface WindowDue {
  key: string;
  sinceTs: number;
  timing: TimedTriggerKind;
}

/** A stretch a timed run would read: from `sinceTs`, over `channelIds` (null: every archived channel). */
export interface CoverageQuery {
  sinceTs: number;
  channelIds: string[] | null;
}

/** A window trigger’s due calculation and whether it runs once per session. */
export interface WindowImpl {
  due(config: unknown, state: TimedState): WindowDue | null;
  oncePerSession(config: unknown): boolean;
}

/** Compiled matching callbacks and their prepared configuration. */
export type PreparedMatch = Omit<MatchImpl, 'prepare'> & { config: unknown };
/** Compiled narrowing callback and its prepared configuration. */
export type PreparedFilter = Omit<FilterImpl, 'prepare'> & { config: unknown };
type Action = (config: unknown, run: ActionRun) => ActionResult | Promise<ActionResult>;

/** Core registrations shared by host and plugin implementations. */
export class RuleKinds {
  private readonly triggers = new Set(HOST.triggers.map((k) => k.type));
  private readonly arrivals = new Set<(m: TextMessage) => void>();
  private readHistory: ((type: string, id: number) => RuleHistory | null) | null = null;
  private reload: (() => void) | null = null;
  /** Settings → Plugins' states (the plugin host binds them); until then no plugin has started. */
  private pluginStates: PluginStates = NONE_STARTED;
  private readonly actions = new Map<string, Action>();
  private readonly matches = new Map<string, MatchImpl>();
  private readonly filters = new Map<string, FilterImpl>();
  private readonly reloads = new Set<() => void>();
  private readonly edits = new Set<(e: RuleEdited) => void>();
  private managedStore: ManagedStore | null = null;
  private readonly settled = new Set<(e: Settled) => void>();
  private readonly coverage = new Set<(q: CoverageQuery) => number | null>();
  private readonly windowsByType = new Map<string, WindowImpl>();
  // Async action descendants cannot start another rule through a trigger.
  private readonly acting = new AsyncLocalStorage<boolean>();
  private fireTrigger: ((type: string, e: TriggerEvent) => void) | null = null;

  /** `kindOf`: the declared kinds registrations must match; this build's registry by default. */
  constructor(private readonly kindOf: RuleKindLookup = ruleKind) {}

  /** Attaches the engine's direct-history reader. */
  bindHistory(read: (type: string, id: number) => RuleHistory | null): void {
    this.readHistory = read;
  }
  history(type: string, id: number): RuleHistory | null {
    return this.readHistory?.(type, id) ?? null;
  }
  onMessage(fn: (m: TextMessage) => void): () => void {
    this.arrivals.add(fn);
    return () => {
      this.arrivals.delete(fn);
    };
  }
  message(m: TextMessage): void {
    for (const fn of this.arrivals) fn(m);
  }
  /** Recompiles after plugin activation or disposal. */
  changed(): void {
    this.reload?.();
  }
  /** Attaches the engine reload after construction. */
  bindChanged(fn: () => void): void {
    this.reload = fn;
  }
  /** Attaches the plugin host's states, so a reason tells an off plugin from one that failed to start. */
  bindPlugins(states: PluginStates): void {
    this.pluginStates = states;
  }
  /** Missing plugin implementations cannot run. */
  unavailable(section: 'triggers' | 'match' | 'filters' | 'actions', type: string): string | null {
    const present = section === 'triggers' ? this.triggers.has(type)
      : section === 'match' ? this.matches.has(type)
      : section === 'filters' ? this.filters.has(type) : this.actions.has(type);
    return present ? null : kindUnavailable(type, this.pluginStates) ?? `No implementation for rule ${section} ${type}.`;
  }
  /** Explains a condition whose implementation is unavailable; actions are checked individually when run. */
  unavailableRule(spec: RuleSpec): string | null {
    return this.unavailable('triggers', spec.trigger.type)
      ?? spec.match.map((part) => this.unavailable('match', part.type)).find((reason) => reason !== null)
      ?? spec.narrow.map((part) => this.unavailable('filters', part.type)).find((reason) => reason !== null)
      ?? null;
  }
  /** Registers a plugin message trigger until its context is disposed. */
  registerTrigger(type: string): () => void {
    this.triggers.add(type);
    return () => {
      this.triggers.delete(type);
    };
  }

  /** Registers an action until its returned disposer is called. */
  action<C>(type: string, run: (config: C, r: ActionRun) => ActionResult | Promise<ActionResult>): () => void {
    const declaration = this.kindOf('actions', type);
    if (!declaration) throw new Error(`No rule action ${type}.`);
    validateActionInterval(declaration.minIntervalMs);
    this.actions.set(type, run as Action);
    return () => {
      this.actions.delete(type);
    };
  }
  /** Registers matching callbacks until their returned disposer is called. */
  match<C, P = C>(type: string, impl: MatchImpl<C, P>): () => void {
    this.matches.set(type, impl as MatchImpl);
    return () => {
      this.matches.delete(type);
    };
  }
  /** Registers narrowing callbacks until their returned disposer is called. */
  filter<C, P = C>(type: string, impl: FilterImpl<C, P>): () => void {
    this.filters.set(type, impl as FilterImpl);
    return () => {
      this.filters.delete(type);
    };
  }
  prepareMatch(p: RulePart): PreparedMatch {
    const impl = this.matches.get(p.type);
    if (!impl) throw new Error(`No implementation for rule match ${p.type}.`);
    return { ...impl, config: impl.prepare ? impl.prepare(p.config) : p.config };
  }
  prepareFilter(p: RulePart): PreparedFilter {
    const impl = this.filters.get(p.type);
    if (!impl) throw new Error(`No implementation for rule filter ${p.type}.`);
    return { ...impl, config: impl.prepare ? impl.prepare(p.config) : p.config };
  }
  run(type: string, config: unknown, r: ActionRun): ActionResult | Promise<ActionResult> {
    const action = this.actions.get(type);
    if (!action) throw new Error(`No implementation for rule action ${type}.`);
    return this.acting.run(true, () => action(config, r));
  }
  trigger(type: string): { fire(e: TriggerEvent): void } {
    if (this.kindOf('triggers', type)?.event !== 'message') throw new Error(`Not a message trigger: ${type}.`);
    return {
      fire: (e) => {
        if (!this.acting.getStore()) this.fireTrigger?.(type, e);
      },
    };
  }
  bindTriggers(fire: (type: string, e: TriggerEvent) => void): void {
    this.fireTrigger = fire;
  }
  readonly managed: ManagedStore = {
    sync: (list) => this.store().sync(list),
    ruleId: (key) => this.store().ruleId(key),
  };
  bindManaged(store: ManagedStore): void {
    this.managedStore = store;
  }
  private store(): ManagedStore {
    if (!this.managedStore) throw new Error('Rules are not initialized.');
    return this.managedStore;
  }
  /** Notifies owners after rules compile, including availability changes. */
  reloaded(): void {
    for (const fn of this.reloads) fn();
  }
  onReloaded(fn: () => void): () => void {
    this.reloads.add(fn);
    return () => { this.reloads.delete(fn); };
  }
  onEdited(fn: (e: RuleEdited) => void): () => void {
    this.edits.add(fn);
    return () => {
      this.edits.delete(fn);
    };
  }
  edited(e: RuleEdited): void {
    for (const fn of this.edits) fn(e);
  }
  onSettled(fn: (e: Settled) => void): () => void {
    this.settled.add(fn);
    return () => {
      this.settled.delete(fn);
    };
  }
  settle(e: Settled): void {
    for (const fn of this.settled) fn(e);
  }
  readonly windows = {
    coveredUntil: (fn: (q: CoverageQuery) => number | null): (() => void) => {
      this.coverage.add(fn);
      return () => {
        this.coverage.delete(fn);
      };
    },
    /** Where the furthest owner's coverage of `q`, without a gap from its start, ends; null when none covers it. */
    covered: (q: CoverageQuery): number | null => {
      const times = [...this.coverage].flatMap((fn) => fn(q) ?? []);
      return times.length ? Math.max(...times) : null;
    },
    register: (type: string, impl: WindowImpl): void => {
      this.windowsByType.set(type, impl);
    },
    get: (type: string): WindowImpl | undefined => this.windowsByType.get(type),
  };
}
