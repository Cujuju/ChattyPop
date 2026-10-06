// Leaf renderer API uses Electron preload or installed page transport. Host modules may call it before transport installation.
import { unwrap } from 'solid-js/store';
import type { RendererApi } from '@shared/contract';
import { isPostingCall, keepPostingLocked } from '@shared/posting';

/** Groups of methods; every other member of RendererApi is a method itself. */
type Group = { [K in keyof RendererApi]: RendererApi[K] extends (...args: never[]) => unknown ? never : K }[keyof RendererApi];
type Method = (...args: unknown[]) => unknown;

/** A transport's API (a page served outside the app), once installed. */
let installed: RendererApi | null = null;
/** Work waiting for a transport, run in call order when it installs. */
const waiting: ((live: RendererApi) => void)[] = [];
/** True while install runs the waiting work: calls that work makes queue behind it, keeping call order. */
let draining = false;

/** The API, if one is there yet and nothing waits: a transport's, else the preload's (present before any script in the app's windows). */
const live = (): RendererApi | undefined => (draining ? undefined : (installed ?? window.chattypop));

/** Preload calls carry desktop audiences; external page calls use the phone transport audience. */
export const windowAudience = (): 'renderer' | 'phone' => (window.chattypop ? 'renderer' : 'phone');

/** Installs a transport's API; calls made earlier run now, in the order they were made. Once per page. */
export function installApi(api: RendererApi): void {
  if (installed) throw new Error('A renderer API is already installed.');
  installed = api;
  draining = true;
  try {
    for (let run = waiting.shift(); run; run = waiting.shift()) {
      // Reports subscription failures through page error handlers while continuing queued work.
      try {
        run(api);
      } catch (err) {
        reportError(err);
      }
    }
  } finally {
    draining = false;
  }
}

/** Arguments sent as plain data: IPC's structured clone throws on a store's proxies, however deep in an argument. */
function invoke(api: RendererApi, group: Group | null, name: string, args: unknown[]): unknown {
  const target = (group ? api[group] : api) as unknown as Record<string, Method>;
  const fn = target[name];
  if (typeof fn !== 'function') throw new Error(`The renderer API has no ${group ? `${group}.` : ''}${name}.`);
  return fn.apply(target, args.map((a) => unwrap(a)));
}

/** A method that runs at once when an API is there, else once one installs (its result then comes as a promise). */
const method =
  (group: Group | null, name: string): Method =>
  (...args) => {
    const api = live();
    if (api) return invoke(api, group, name, args);
    return new Promise((resolve, reject) =>
      waiting.push((a) => {
        try {
          resolve(invoke(a, group, name, args));
        } catch (err) {
          reject(err);
        }
      }),
    );
  };

const group = <G extends Group>(name: G, wrap: (key: string, fn: Method) => Method = (_key, fn) => fn): RendererApi[G] =>
  new Proxy({} as RendererApi[G], { get: (_target, key) => (typeof key === 'string' ? wrap(key, method(name, key)) : undefined) });

/** A posting call's PostingLocked, which IPC and the phone's HTTP carry as a plain error, rejects as one again. */
const keepLocked = (key: string, fn: Method): Method => (isPostingCall(key) ? (...args) => keepPostingLocked(Promise.resolve(fn(...args))) : fn);

/** Subscribes now, or once an API installs; the returned function unsubscribes either way. */
function onEvent(listener: Parameters<RendererApi['onEvent']>[0]): () => void {
  const api = live();
  if (api) return api.onEvent(listener);
  let off: (() => void) | null = null;
  let cancelled = false;
  waiting.push((a) => {
    if (!cancelled) off = a.onEvent(listener);
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/** The renderer API. Host code reaches it only here, never through `window.chattypop`. */
export const api: RendererApi = {
  core: group('core'),
  openRouter: group('openRouter'),
  typeSafe: group('typeSafe'),
  discord: group('discord', keepLocked),
  storage: group('storage'),
  plugins: group('plugins'),
  rules: group('rules'),
  media: group('media'),
  desktop: group('desktop'),
  marketplace: group('marketplace'),
  openPluginsFolder: method(null, 'openPluginsFolder') as RendererApi['openPluginsFolder'],
  restartApp: method(null, 'restartApp') as RendererApi['restartApp'],
  openPanelWindow: method(null, 'openPanelWindow') as RendererApi['openPanelWindow'],
  showInMainWindow: method(null, 'showInMainWindow') as RendererApi['showInMainWindow'],
  onEvent,
};
