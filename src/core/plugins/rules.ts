// Scoped plugin rule registrations, guarded callbacks and context disposal.
import type { RuleInput, RuleSpec } from '@shared/rules';
import { managedRuleKey, pluginJevFeature, type JevFeatureRef, type PluginDescriptor, type RuleTypes, type RuleConfig } from '@shared/bundledTypes';
import type { RuleSection } from '@shared/ruleKinds/types';
import { errorMessage } from '@shared/errors';
import type { ActionResult } from '../rules/actions';
import type { ActionRun, CoverageQuery, MatchContext, MatchImpl, FilterImpl, TriggerEvent, RuleEdited, Settled, RuleKinds } from '../rules/kinds';
import type { RuleQuestion } from '../jev/questions';
import type { TextMessage } from '../arrival';
import type { RuleHistory } from '../rules/history';
import type { ManagedRule } from '../rules/managed';
import { servicesLive, type Registrations } from './api';
import type { RuleRuns } from './bundled';
import { registration } from './registrationCheck';

type ActionReturn<D, T extends string> = D extends { rules: { actions: readonly (infer K)[] } }
  ? Extract<K, { type: T }> extends { phase: 'match' } ? ActionResult : ActionResult | Promise<ActionResult>
  : ActionResult | Promise<ActionResult>;

/** A plugin match's Jev question: `features` names switches it declares, or the host's. */
export type PluginRuleQuestion<F extends string> = Omit<RuleQuestion, 'features'> & { features: readonly F[] };
/** A plugin's match callbacks (MatchImpl) with its questions' switches named as in its descriptor. */
export type PluginMatchImpl<C, P, F extends string> = Omit<MatchImpl<C, P>, 'question'> & {
  question?(config: P, c: MatchContext): PluginRuleQuestion<F> | null;
};

/** Ordinary rules imported atomically with plugin migration writes. */
export type RuleImporter = (rows: readonly { input: RuleInput; armedAt: number }[], record?: () => void) => number[];

/** Stored rule identity and parsed specification; null preserves unreadable rules for conservative consumers. */
export interface RuleSnapshot {
  id: number;
  spec: RuleSpec | null;
}

/** Rule services restricted to the kinds in one plugin descriptor. */
export interface PluginRules<D extends PluginDescriptor> extends RuleRuns {
  read(): RuleSnapshot[];
  import: RuleImporter;
  action<T extends RuleTypes<D, 'actions'>>(
    type: T,
    run: (config: RuleConfig<D, 'actions', T>, run: ActionRun) => ActionReturn<D, T>,
  ): void;
  match<T extends RuleTypes<D, 'match'>, P = RuleConfig<D, 'match', T>>(
    type: T,
    impl: PluginMatchImpl<RuleConfig<D, 'match', T>, P, JevFeatureRef<D>>,
  ): void;
  filter<T extends RuleTypes<D, 'filters'>, P = RuleConfig<D, 'filters', T>>(
    type: T,
    impl: FilterImpl<RuleConfig<D, 'filters', T>, P>,
  ): void;
  trigger<T extends RuleTypes<D, 'triggers'>>(type: T): {
    fire(e: Omit<TriggerEvent, 'accepts'> & {
      accepts(config: RuleConfig<D, 'triggers', T>): boolean;
    }): void;
  };
  onMessage(fn: (m: TextMessage) => void): void;
  history<T extends RuleTypes<D, 'actions'>>(type: T, id: number): RuleHistory | null;
  onSettled(fn: (event: Settled) => void): void;
  onEdited(fn: (event: RuleEdited) => void): void;
  onReloaded(fn: () => void): void;
  managed: {
    sync(list: ManagedRule[]): boolean;
    /** The stored key of one of this plugin's managed rules, as `ActionRun.rule.managed` reports it. */
    key(local: string): string;
    /** The id of one of this plugin's managed rules, or null before it is created. */
    ruleId(local: string): number | null;
  };
  windows: {
    /** Where the plugin's coverage of every channel in `q`, without a gap from `q.sinceTs`, ends; null for none. */
    coveredUntil(fn: (q: CoverageQuery) => number | null): void;
  };
}

/** Builds inert-after-unload services; every registration is removed by the host. */
export function pluginRules<D extends PluginDescriptor>(
  plugin: D,
  kinds: RuleKinds,
  reg: Registrations,
  runs: RuleRuns,
  guard: (fn: () => unknown) => void,
  read: () => RuleSnapshot[],
  importRules: RuleImporter = () => { throw new Error('Rule import is unavailable.'); },
): PluginRules<D> {
  const live = (): boolean => servicesLive(reg);
  const managedKey = (local: string): string => managedRuleKey(plugin.manifest.id, local);
  const declared = (section: RuleSection, type: string): void => {
    if (!plugin.rules?.[section]?.some((kind) => kind.type === type)) throw new Error(`${plugin.manifest.id} implements rule ${section} ${type} but declares none`);
  };
  const report = (err: unknown): void => guard(() => {
    throw err;
  });
  const safe = <T,>(fn: () => T, fallback: T): T => {
    if (!live()) return fallback;
    try {
      return fn();
    } catch (err) {
      report(err);
      return fallback;
    }
  };
  // Preparation errors must abort compilation, rather than pass an invalid prepared value to a callback.
  const prepare = <C, P>(fn: (config: C) => P) => (config: C): P => {
    try {
      return fn(config);
    } catch (err) {
      report(err);
      throw err;
    }
  };
  return {
    ...runs,
    read: () => {
      if (!live()) return [];
      try {
        return read();
      } catch (err) {
        report(err);
        throw err;
      }
    },
    import: (rows, record) => live() ? importRules(rows, record) : [],
    update: (...args) => {
      if (live()) runs.update(...args);
    },
    action: (type, run) => {
      declared('actions', type);
      if (!live()) return;
      reg.registered.add(registration('rule actions', type));
      reg.disposers.push(kinds.action(type, (config, event) => {
        const failed = (err: unknown): ActionResult => {
          if (live()) report(err);
          return {
            outcome: 'failed',
            detail: errorMessage(err),
          };
        };
        if (!live()) return {
          outcome: 'skipped',
          detail: `Needs the ${plugin.manifest.name} plugin, which is off.`,
        };
        try {
          const result = run(config as RuleConfig<D, 'actions', typeof type>, event);
          if (result instanceof Promise) {
            if (plugin.rules?.actions?.find((kind) => kind.type === type)?.phase === 'match') {
              void result.catch((err) => { if (live()) report(err); });
              return failed(new Error('A match-phase action must finish synchronously.'));
            }
            return result.catch(failed);
          }
          return result;
        } catch (err) {
          return failed(err);
        }
      }));
    },
    match: (type, impl) => {
      declared('match', type);
      if (!live()) return;
      reg.registered.add(registration('rule match', type));
      type Prepared = Parameters<NonNullable<typeof impl.direct>>[0];
      reg.disposers.push(kinds.match<RuleConfig<D, 'match', typeof type>, Prepared>(type, {
        prepare: impl.prepare ? prepare(impl.prepare) : undefined,
        direct: impl.direct ? (c, event) => safe(() => impl.direct!(c, { ...event, facts: event.facts.scoped(plugin.manifest.id) }), null) : undefined,
        question: impl.question ? (c, event) => {
          // An undeclared switch throws inside the guard: the plugin's error, not the matcher's.
          const question = safe(() => {
            const q = impl.question!(c, { ...event, facts: event.facts.scoped(plugin.manifest.id) });
            return q && { ...q, features: q.features.map((f) => pluginJevFeature(plugin, f)) };
          }, null);
          return question ? {
            ...question,
            match: (answer) => safe(() => question.match(answer), null),
          } : null;
        } : undefined,
      }));
    },
    filter: (type, impl) => {
      declared('filters', type);
      if (!live()) return;
      reg.registered.add(registration('rule filters', type));
      type Prepared = Parameters<typeof impl.test>[0];
      reg.disposers.push(kinds.filter<RuleConfig<D, 'filters', typeof type>, Prepared>(type, {
        prepare: impl.prepare ? prepare(impl.prepare) : undefined,
        test: (c, event) => safe(() => impl.test(c, { ...event, facts: event.facts.scoped(plugin.manifest.id) }), false),
      }));
    },
    trigger: (type) => {
      declared('triggers', type);
      const trigger = kinds.trigger(type);
      if (live()) {
        reg.disposers.push(kinds.registerTrigger(type));
        reg.registered.add(registration('rule triggers', type));
      }
      return {
        fire: (event) => {
          if (live()) trigger.fire({
            ...event,
            accepts: (config) => safe(() => event.accepts(config as RuleConfig<D, 'triggers', typeof type>), false),
          });
        },
      };
    },
    onMessage: (fn) => {
      if (live()) reg.disposers.push(kinds.onMessage((m) => safe(() => fn(m), undefined)));
    },
    history: (type, id) => {
      declared('actions', type);
      return safe(() => kinds.history(type, id), null);
    },
    onSettled: (fn) => {
      if (live()) reg.disposers.push(kinds.onSettled((event) => safe(() => fn(event), undefined)));
    },
    onReloaded: (fn) => {
      if (live()) reg.disposers.push(kinds.onReloaded(() => safe(fn, undefined)));
    },
    onEdited: (fn) => {
      if (live()) reg.disposers.push(kinds.onEdited((event) => safe(() => fn(event), undefined)));
    },
    managed: {
      sync: (list) => live() && kinds.managed.sync(list.map((rule) => ({
        ...rule,
        key: managedKey(rule.key),
        input: () => {
          try {
            return rule.input();
          } catch (err) {
            if (live()) report(err);
            throw err;
          }
        },
      }))),
      key: managedKey,
      ruleId: (local) => (live() ? kinds.managed.ruleId(managedKey(local)) : null),
    },
    windows: {
      coveredUntil: (fn) => {
        if (live()) reg.disposers.push(kinds.windows.coveredUntil((q) => safe(() => fn(q), null)));
      },
    },
  };
}
