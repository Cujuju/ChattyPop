// Tracks issued main-work completion keys and invokes the latest activation’s handler. Finalizers grant report-specific bookkeeping, including after unload.
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import { completionOf, type AnyChannels, type CompletionsOf, type EventsOf } from '@shared/pluginChannels';
import type { ActionResult } from '../rules/actions';
import type { Db } from '../db';
import type { DerivedText } from './bundled';
import { pluginDb, type PluginDb } from './pluginDb';

type Reports<D> = CompletionsOf<ChannelsOf<D>>;
/** A completion report a plugin declares. */
export type CompletionName<D> = keyof Reports<D> & string;
type ReportArgs<D, K extends keyof Reports<D>> = Reports<D>[K] extends (...args: infer A) => unknown ? A : never;
type ReportResult<D, K extends keyof Reports<D>> = Reports<D>[K] extends (...args: never[]) => infer R ? R : never;
type Events<D> = EventsOf<ChannelsOf<D>>;

/** A report handler's grant (Finalize), its events typed to the plugin's contract. */
export type CoreFinalize<D> = Omit<Finalize, 'channels'> & {
  channels: { emit<K extends keyof Events<D> & string>(name: K, payload: Events<D>[K]): void };
};

/** Completion reports (§3): main's reports of work the plugin handed it, handled apart from its ordinary calls. */
export interface PluginCompletions<D extends PluginDescriptor> {
  /** Records a completion key before send. A throwing send withdraws it; disabled or full ledgers return false without sending. */
  dispatch(name: CompletionName<D>, key: string, send: () => void): boolean;
  /** Stops expecting report `name` for `key` (the plugin gave up waiting and ignores a late one), freeing its place. */
  withdraw(name: CompletionName<D>, key: string): void;
  /** Handles issued or accepted persisted keys once. finalize grants only report writes until handler return; latest handler survives unload. Unknown reports resolve undefined. */
  handle<K extends CompletionName<D>>(
    name: K,
    options: { key(...args: ReportArgs<D, K>): string; accept?(...args: ReportArgs<D, K>): boolean },
    fn: (args: ReportArgs<D, K>, finalize: CoreFinalize<D>) => ReportResult<D, K>,
  ): void;
}

/** What a report's handler may do, only while it runs synchronously: then writes throw and the rest does nothing. */
export interface Finalize {
  /** The plugin's own tables; writes throw PluginInactiveError once the handler returned. */
  db: PluginDb;
  /** Rewrites a rule action's recorded outcome (a late report). */
  rules: { update(runId: number, actionId: string, type: string, r: ActionResult): void };
  /** An event for its declared audiences (typed by the context). */
  channels: { emit(name: string, payload: unknown): void };
  /** derivedText.settle: the plugin's text for a message settled; null: none came. */
  settle(messageId: string, t: DerivedText | null, record?: () => void): void;
}

/** The host effects a finalizer grants, unfenced; the finalizer gates them to the handler's synchronous run. */
export interface FinalizeDeps {
  pluginId: string;
  db: () => Db;
  update: Finalize['rules']['update'];
  emit: Finalize['channels']['emit'];
  settle: Finalize['settle'];
}

/** Runs `fn` with a finalizer open only until `fn` returns. */
export function withFinalizer<T>(d: FinalizeDeps, fn: (finalize: Finalize) => T): T {
  let open = true;
  const gated = <A extends unknown[]>(effect: (...args: A) => void) => (...args: A): void => {
    if (open) effect(...args);
  };
  const finalize: Finalize = {
    db: pluginDb(d.db, () => open, d.pluginId),
    rules: { update: gated(d.update) },
    channels: { emit: gated(d.emit) },
    settle: gated(d.settle),
  };
  try {
    return fn(finalize);
  } finally {
    open = false;
  }
}

/** One activation's handler for a report, as the context registers it: its key, persisted work, and the run. */
export interface CompletionHandler {
  key(args: unknown[]): string;
  accept?(args: unknown[]): boolean;
  run(args: unknown[]): unknown;
}

/** One bundled plugin's completion reports for the core process: the keys it issued per report, and their handlers. */
export class CompletionLedger {
  private readonly issued = new Map<string, Set<string>>();
  private readonly handlers = new Map<string, CompletionHandler>();

  constructor(private readonly channels: AnyChannels | undefined) {}

  /** Records issued completion keys unless capacity is full. Keeps keys until reported or withdrawn; never evicts pending work. */
  issue(name: string, key: string): boolean {
    const declared = completionOf(this.channels, name);
    if (!declared) throw new Error(`No completion report ${name} is declared.`);
    const keys = this.issued.get(name) ?? new Set<string>();
    this.issued.set(name, keys);
    if (!keys.has(key) && keys.size >= declared.max) return false;
    keys.add(key);
    return true;
  }

  /** `key` is issued for report `name` and not yet reported or withdrawn. */
  holds(name: string, key: string): boolean {
    return this.issued.get(name)?.has(key) ?? false;
  }

  /** Forgets issued `key` of report `name`. */
  withdraw(name: string, key: string): void {
    this.issued.get(name)?.delete(key);
  }

  /** Takes an activation's handlers, once it activated: the latest stay while the plugin is off. */
  adopt(handlers: ReadonlyMap<string, CompletionHandler>): void {
    for (const [name, handler] of handlers) this.handlers.set(name, handler);
  }

  /** Whether any activation handled `name` this core process. */
  handles(name: string): boolean {
    return this.handlers.has(name);
  }

  /**
   * Main's report `name`: its handler's result when it names an issued key (forgotten once reported) or work the plugin
   * accepts as persisted; undefined, running nothing, otherwise.
   */
  report(name: string, args: unknown[]): unknown {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for completion report ${name}.`);
    const issued = this.issued.get(name)?.delete(handler.key(args)) ?? false;
    if (!issued && !handler.accept?.(args)) return undefined;
    return handler.run(args);
  }
}

/**
 * Plugin `plugin`'s completions: issuing goes to its `ledger` while its activation is `live`; a handler goes to `stage`,
 * for the ledger to adopt once the activation succeeded.
 */
export function pluginCompletions<D extends PluginDescriptor>(
  plugin: D,
  ledger: CompletionLedger,
  live: () => boolean,
  grants: Omit<FinalizeDeps, 'pluginId'>,
  stage: (name: string, handler: CompletionHandler) => void,
): PluginCompletions<D> {
  const pluginId = plugin.manifest.id;
  const declared = (name: string): void => {
    if (!completionOf(plugin.channels, name)) throw new Error(`${pluginId} has no declared completion report ${name}`);
  };
  return {
    dispatch: (name, key, send) => {
      declared(name);
      const held = ledger.holds(name, key);
      if (!live() || !ledger.issue(name, key)) return false;
      try {
        send();
      } catch (err) {
        if (!held) ledger.withdraw(name, key); // nothing reached main, so no report will come
        throw err;
      }
      return true;
    },
    withdraw: (name, key) => {
      declared(name);
      ledger.withdraw(name, key);
    },
    handle: (name, options, fn) => {
      declared(name);
      if (!live()) return;
      type Args = Parameters<typeof options.key>;
      stage(name, {
        key: (args) => options.key(...(args as Args)),
        accept: options.accept && ((args) => options.accept!(...(args as Args))),
        run: (args) => withFinalizer({ pluginId, ...grants }, (finalize) => fn(args as Args, finalize as CoreFinalize<D>)),
      });
    },
  };
}
