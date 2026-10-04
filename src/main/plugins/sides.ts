// Bundled plugins' main sides (docs/plugin-architecture.md §5): each activated once, its registrations held until it
// succeeds; core's events for main reach their listeners, and windows' main calls reach what the plugins serve.
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { PluginInactiveError, pluginCallResult, type PluginCallResult } from '@shared/pluginCall';
import { audiencesOf, membersOf } from '@shared/pluginChannels';
import { errorMessage } from '@shared/errors';
import { createMainContext, type MainPlugin, type MainPluginDeps } from './context';
import { whileActive, type RunStart } from './states';

const key = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** The started main sides, as the app's transports reach them. */
export interface MainSides {
  /** A window's call to a plugin's main side: the inactive answer while core's list has the plugin off. */
  callMain(pluginId: string, name: string, args: unknown[]): Promise<PluginCallResult>;
  /** Hands core's plugin event to its main listener when its audiences include main. */
  deliver(e: AppEvent): void;
  /** Brings every switch-governed resource to its plugin's state; resolves once each transition ran. */
  sync(): Promise<void>;
  /** Stops the resources for good (app quit). */
  stop(): Promise<void>;
}

/**
 * Activates each main side once. Main sides don't follow Settings → Plugins on/off: a plugin that is off never asks them
 * for anything, since its core and renderer sides are what stop. Resources a plugin registers with ctx.whileActive
 * follow the switch. An activation that throws, or leaves a declared main call unserved, is logged and registers nothing.
 */
export function startMainSides(
  plugins: readonly MainPlugin[],
  d: MainPluginDeps,
  /** Every installed plugin's descriptor, main side or not: whose events are for main. */
  installed: readonly PluginDescriptor[],
): MainSides {
  const listeners = new Map<string, (payload: unknown) => unknown>();
  const served = new Map<string, (...args: unknown[]) => unknown>();
  const resources: ReturnType<typeof whileActive>[] = [];
  const startResource = (id: string, start: RunStart): void => {
    const resource = whileActive(id, () => d.states.active(id), start, (err) => d.diag('plugin-resource-failed', { pluginId: id, message: errorMessage(err) }));
    resources.push(resource);
    void resource.sync();
  };
  for (const p of plugins) {
    const id = p.plugin.manifest.id;
    // Held until the activation returns having served every declared main call; a failed one leaves nothing registered.
    const pending: (() => void)[] = [];
    let activated = false;
    const register = (apply: () => void): void => void (activated ? apply() : pending.push(apply));
    const servedNames = new Set<string>();
    try {
      p.activate(createMainContext(p.plugin, d, {
        serve: (name, fn) => {
          servedNames.add(name);
          register(() => served.set(key(id, name), fn));
        },
        on: (name, fn) => register(() => listeners.set(key(id, name), fn)),
        whileActive: (start) => register(() => startResource(id, start)),
        stage: register,
      }));
      const missing = membersOf(p.plugin.channels, 'main').filter((name) => !servedNames.has(name));
      if (missing.length) throw new Error(`${id} declares but never served main calls: ${missing.join(', ')}`);
    } catch (err) {
      d.diag('plugin-activation-failed', { pluginId: id, message: errorMessage(err) });
      continue;
    }
    activated = true;
    pending.forEach((apply) => apply());
  }
  const descriptors = new Map(installed.map((p) => [p.manifest.id, p]));
  const sync = (): Promise<void> => Promise.all(resources.map((r) => r.sync())).then(() => undefined);
  d.states.onChange(() => void sync());
  return {
    callMain: (pluginId, name, args) => {
      const fn = served.get(key(pluginId, name));
      if (!fn) return Promise.reject(new Error(`Plugin ${pluginId} has no main function ${name}`));
      // Main sides keep running while their plugin is off; a window's call reaches one only while it is on (core's list, now).
      return pluginCallResult(async () => {
        if (!(await d.states.confirmed(pluginId))) throw new PluginInactiveError(pluginId);
        return fn(...args);
      });
    },
    deliver: (e) => {
      if (e.type !== 'plugin-event' || !audiencesOf(descriptors.get(e.pluginId)?.channels, 'events', e.name).includes('main')) return;
      const fn = listeners.get(key(e.pluginId, e.name));
      if (!fn) return d.diag('plugin-event-unhandled', { pluginId: e.pluginId, name: e.name });
      void Promise.resolve()
        .then(() => fn(e.payload))
        .catch((err: unknown) => d.diag('plugin-event-failed', { pluginId: e.pluginId, name: e.name, message: errorMessage(err) }));
    },
    sync,
    stop: async () => void (await Promise.all(resources.map((r) => r.stop()))),
  };
}
