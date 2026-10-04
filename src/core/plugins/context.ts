// A bundled plugin's core context (docs/plugin-architecture.md §3–§4): the extension points and services its core side registers through. Registrations are dropped when disabled; declared completion reports reach the latest handler.
import { createArchiveRefViews, migrateArchiveRefs } from './archiveRefs';
import { insertRule, loadRule, ruleRows } from '../rules/ruleStore';
import { registerSearchToken, type SearchTokenReader } from '../searchTokens';
import { hostRanker, registerSearchRanker, type SearchRanker } from '../searchRankers';
import { join } from 'node:path';
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import { pluginTableName } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { completionOf, decoderOf, membersOf, servedMember, type EventsOf, type Served } from '@shared/pluginChannels';
import { PluginInactiveError } from '@shared/pluginCall';
import { getSetting } from '../db';
import { servicesLive, type HostDeps, type Registrations } from './api';
import { pluginAi, type PluginAi } from './aiContext';
import { derivedTextSettler, pluginArchive, type PluginArchive } from './archiveContext';
import { pluginCompletions, type CompletionLedger, type PluginCompletions } from './completions';
import { pluginJev, type PluginJev } from './jevContext';
import { lifetimeFetch, pluginLifetime, type Lifetime } from './lifetime';
import { descriptorFetch, type PluginFetch } from './net';
import { pluginDb, type PluginDb } from './pluginDb';
import { corePreferences } from './preferences';
import type { CorePreferences } from '@shared/preferences';
import { pluginRules, type PluginRules } from './rules';
import { pluginRuleRuns, type BundledDeps, type HostPlugins } from './bundled';
import { registration, SEARCH_RANKER } from './registrationCheck';

/** Services and extension points scoped to one bundled plugin. */
export interface CoreContext<D extends PluginDescriptor = PluginDescriptor> {
  readonly plugin: D;
  /** This activation: providers, Jev and completions it hands out are cancelled when it ends; fence other async work. */
  lifetime: Lifetime;
  session: {
    lastSeenAt(): number;
    /**
     * This activation continues the previous one without a gap: the plugin was on through the end of the previous app
     * session and hasn't been off since. False on first run, after being off or absent from a build, or a failed start;
     * then caches of what the archive held (history coverage) must be rebuilt.
     */
    resumed: boolean;
  };
  storage: {
    /**
     * The archive database (read when used: the archive can move). Writes, through statements and transactions however
     * long held, throw PluginInactiveError once this activation ended; reads stay open.
     */
    readonly db: PluginDb;
    /** Runs `fn` in one transaction of `db`, returning its result; its writes are fenced as `db`'s. */
    transaction<T>(fn: () => T): T;
    /** Its table `name` as stored: p_<plugin id>_<name>. */
    table(name: string): string;
    /** Runs the steps not yet applied, in order; append steps, never edit a shipped one. Throws once the activation ended. */
    migrate(steps: readonly string[]): void;
    /** This computer's folder for the plugin (downloads, caches; not archive data); may not exist yet. */
    dataDir: string;
    /** The archive's media folder; the plugin keeps files in a subfolder of its own. */
    mediaDir: string;
  };
  /** Its declared preferences (descriptor `preferences`), stored as plugin.<id>.<name>. */
  preferences: CorePreferences<D>;
  archive: PluginArchive;
  identity: {
    names(): string[] | null;
    /** The signed-in Discord user, once main reports it (at once when already known). */
    onSelf(fn: (userId: string) => void): void;
  };
  search: {
    token(key: string, read: SearchTokenReader): void;
    /** Its search ranker (descriptor `search.ranker`): reorders full-text hits after windows show them. */
    rerank(rank: SearchRanker): void;
  };
  people: {
    /** Guarded per-person reader served through this plugin's own channel; null after unload or failure. */
    section<T>(read: (userId: string) => T): (userId: string) => T | null;
  };
  rules: PluginRules<D>;
  ai: PluginAi<D>;
  jev: PluginJev<D>;
  net: {
    /**
     * HTTPS to a host the descriptor lists (network.hosts) or a subdomain of one, or HTTP(S) to the origin of an address
     * the owner set (network.ownerUrls), redirects included; anything else rejects. The only way a plugin reaches the
     * network (a test holds plugins to it). Scoped to the activation: it settles with PluginInactiveError when that ends.
     */
    fetch: PluginFetch;
  };
  channels: {
    /** Serves every core call the contract declares but its completion reports; the host checks each caller's audience. */
    serve(impl: Served<ChannelsOf<D>, 'core'>): void;
    /** An event for its declared audiences. */
    emit<K extends keyof EventsOf<ChannelsOf<D>> & string>(name: K, payload: EventsOf<ChannelsOf<D>>[K]): void;
  };
  /** Main's reports of work the plugin handed it (channel members declared with `completion`). */
  completions: PluginCompletions<D>;
  log(...args: unknown[]): void;
}

/**
 * A plugin's core side (its folder's core/index.ts). activate may return a function that runs on unload. It is
 * synchronous: bundled plugins start during core init, before the catch-up asks their Jev questions.
 */
export interface CorePlugin<D extends PluginDescriptor = PluginDescriptor> {
  plugin: D;
  activate(ctx: CoreContext<D>): void | (() => void);
}

/** Builds a plugin's context; everything it registers goes in `reg`, which the host drops on unload. */
export function createCoreContext<D extends PluginDescriptor>(
  plugin: D,
  /** The plugin's place in the build list; orders its Jev questions and attachment notes among other plugins'. */
  buildIndex: number,
  deps: HostDeps & { bundled: BundledDeps },
  reg: Registrations,
  plugins: HostPlugins,
  /** Runs plugin code, recording a throw on the plugin. */
  guard: (fn: () => unknown) => void,
  /** The plugin's completion reports for the core process, kept across activations. */
  completions: CompletionLedger,
): CoreContext<D> {
  const id = plugin.manifest.id;
  const { emit, bundled } = deps;
  createArchiveRefViews(bundled.ready(), plugin, false);
  const lifetime = pluginLifetime(id);
  reg.disposers.push(() => lifetime.end());
  /** Until the plugin unloads; what it still holds then does nothing. */
  const live = (): boolean => servicesLive(reg);
  const ask = <T>(fn: () => T, fallback: T): T => {
    if (!live()) return fallback;
    try {
      return fn();
    } catch (err) {
      guard(() => { throw err; });
      return fallback;
    }
  };
  const send = (e: AppEvent): void => void (live() && emit(e));
  // Main fans it out to the event's declared audiences (windows, the phone, main).
  const event = (name: string, payload: unknown): AppEvent => ({ type: 'plugin-event', pluginId: id, name, payload });
  const runs = pluginRuleRuns(deps.db, emit, bundled.now);
  const db = pluginDb(bundled.ready, lifetime.live, id);
  return {
    plugin,
    lifetime: { signal: lifetime.signal, live: lifetime.live, fence: lifetime.fence },
    session: { lastSeenAt: () => bundled.lastSeenAt?.() ?? bundled.now(), resumed: plugins.resumed ?? false },
    storage: {
      db,
      transaction: (fn) => db.transaction(fn)(),
      table: (name) => pluginTableName(id, name),
      migrate: (steps) => {
        if (!lifetime.live()) throw new PluginInactiveError(id);
        migrateArchiveRefs(bundled.ready(), plugin, steps);
      },
      dataDir: bundled.pluginData.unmoved[id] ?? join(bundled.pluginData.root, id),
      mediaDir: bundled.mediaDir,
    },
    preferences: corePreferences(plugin, bundled, reg, live),
    archive: pluginArchive(id, buildIndex, deps, reg, plugins, live, ask, send, guard),
    identity: {
      names: () => bundled.readerNames?.() ?? null,
      onSelf: (fn) => {
        reg.onSelf.push(fn);
        const known = plugins.self();
        if (known !== null) guard(() => fn(known));
      },
    },
    search: {
      token: (key, read) => {
        if (!plugin.search?.tokens?.some((token) => token.key === key)) throw new Error(`${id} has no declared search token ${key}`);
        if (live()) reg.disposers.push(registerSearchToken(key, (value) => ask(() => read(value), { sql: '0', params: [] })));
      },
      rerank: (rank) => {
        if (!plugin.search?.ranker) throw new Error(`${id} declares no search ranker`);
        if (!live()) return;
        if (reg.registered.has(registration('search ranker', SEARCH_RANKER))) throw new Error(`${id} registers one search ranker`);
        reg.disposers.push(registerSearchRanker(buildIndex, hostRanker(rank, live, lifetime.fence, (err) => guard(() => { throw err; })), live));
        reg.registered.add(registration('search ranker', SEARCH_RANKER));
      },
    },
    people: { section: (read) => (userId) => ask(() => read(userId), null) },
    rules: pluginRules(plugin, bundled.rules, reg, runs, guard, () => ruleRows(bundled.ready()).map((row) => ({ id: row.id, spec: loadRule(row).spec })), (rows, record) => {
      const db = bundled.ready();
      const ids = db.transaction(() => {
        const ids = rows.map(({ input, armedAt }) => insertRule(db, input, bundled.now(), null, armedAt));
        record?.();
        return ids;
      })();
      bundled.rules.changed();
      send({ type: 'rules-changed' });
      return ids;
    }),
    ai: pluginAi(plugin, bundled, reg, lifetime.signal, ask, guard),
    jev: pluginJev(plugin, buildIndex, bundled, reg, lifetime, live, ask),
    net: {
      fetch: lifetimeFetch(descriptorFetch(plugin, (key) => getSetting(bundled.ready(), key), bundled.send), lifetime),
    },
    channels: {
      serve: (impl) => {
        if (!live()) return;
        for (const name of membersOf(plugin.channels, 'core')) {
          if (completionOf(plugin.channels, name)) continue; // ctx.completions.handle
          const fn = servedMember(impl, name);
          if (!fn) throw new Error(`${id} declares core call ${name} but serves none`);
          const decode = decoderOf(plugin.channels, name);
          // Its arguments are checked before the handler runs, whichever transport brought them.
          reg.calls.set(name, decode ? (...args) => fn(...decode(args)) : fn);
          reg.registered.add(registration('core call', name));
        }
      },
      emit: (name, payload) => send(event(name, payload)),
    },
    completions: pluginCompletions(plugin, completions, live, {
      db: bundled.ready,
      update: runs.update,
      emit: (name, payload) => emit(event(name, payload)),
      settle: derivedTextSettler(id, bundled, plugins),
    }, (name, handler) => {
      if (!reg.handlers) throw new Error(`${id} handles completion reports during activate`);
      reg.handlers.set(name, handler);
      reg.registered.add(registration('completion handler', name));
    }),
    log: (...args) => console.log(`[plugin ${id}]`, ...args),
  };
}
