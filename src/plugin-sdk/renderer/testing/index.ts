// Plugin SDK, renderer testing (docs/plugin-architecture.md §15): the window a plugin's renderer side runs in, over an
// in-memory transport with an explicit audience, reaching a core (and main) test harness as the app's transports do.
// Never bundled into the app: only tests import it (tests/pluginTesting.test.ts).
import { installApi } from '@/api';
import type { AppEvent, RendererApi } from '@shared/contract';
import { phoneAppEvent } from '@shared/phone';
import type { PluginCallResult } from '@shared/pluginCall';
import { audiencesOf, type Audience } from '@shared/pluginChannels';
import { decodeWire, encodeWire } from '@shared/wire';
import { createPhoneRendererApi } from '../shell/phoneApi';
import { corePort, mainPort, type CorePort, type MainPort } from '../../shared/testing/ports';
import type { TestWindowFn } from './types';

export type * from './types';

/** Whether the window was made: the renderer SDK keeps one API per page. */
let made = false;

const absent = (what: string) => (): Promise<never> => Promise.reject(new Error(`A test window has no ${what}.`));
/** A group of the desktop API the harness doesn't carry: each method rejects, naming it. */
const without = <T extends object>(group: string): T =>
  new Proxy({} as T, { get: (_t, method) => (typeof method === 'string' ? absent(`${group}.${method}`) : undefined) });

/** Whether plugin event `e` is for `audience`, by the installed descriptors; any other event is for every desktop window. */
function reaches(port: CorePort, e: AppEvent, audience: Audience): boolean {
  if (e.type !== 'plugin-event') return true;
  return audiencesOf(port.installed.find((p) => p.manifest.id === e.pluginId)?.channels, 'events', e.name).includes(audience);
}

/** The preload's API over the harnesses: core's service and the plugin calls main forwards, stamped as a desktop window's. */
function desktopApi(core: CorePort, main: MainPort | null, deliver: (fn: (e: AppEvent) => void) => void): RendererApi {
  return {
    core: new Proxy({} as RendererApi['core'], { get: (_t, method) => (typeof method === 'string' ? (...params: unknown[]) => core.call(method, ...params) : undefined) }),
    plugins: {
      callCore: (pluginId, name, args) => core.call('pluginCall', 'renderer', pluginId, name, args) as Promise<PluginCallResult>,
      callMain: main ? (pluginId, name, args) => main.callMain(pluginId, name, args) : absent('main process'),
    },
    openRouter: without('openRouter'),
    typeSafe: without('typeSafe'),
    discord: without('discord'),
    storage: without('storage'),
    rules: without('rules'),
    media: without('media'),
    desktop: without('desktop'),
    marketplace: without('marketplace'),
    openPluginsFolder: absent('plugins folder'),
    restartApp: absent('app restart'),
    openPanelWindow: absent('panel windows'),
    showInMainWindow: () => undefined,
    onEvent: (listener) => {
      deliver(listener);
      return () => undefined;
    },
  };
}

export const testWindow: TestWindowFn = (o) => {
  if (made) throw new Error('One test window per test file: the renderer SDK keeps one API per page.');
  made = true;
  const core = corePort(o.core.link);
  const main = o.main ? mainPort(o.main.link) : null;
  const received: AppEvent[] = [];
  const listeners = new Set<(e: AppEvent) => void>();
  const deliver = (e: AppEvent): void => {
    received.push(e);
    listeners.forEach((fn) => fn(e));
  };
  // With a main harness, events come as the app's do: through main's router. Without one, straight from core.
  if (o.audience === 'renderer') {
    if (main) main.on(deliver);
    else core.on((e) => reaches(core, e, 'renderer') && deliver(e));
    Object.assign(globalThis, { window: { chattypop: desktopApi(core, main, (fn) => listeners.add(fn)) } });
  } else {
    // The phone's wire both ways: its codec, and what the phone may get (phoneAppEvent; plugin events by their audiences).
    const wire = <T>(value: unknown): T => decodeWire(encodeWire(value)) as T;
    if (main) main.onPhone((e) => deliver(wire(e)));
    else
      core.on((e) => {
        const shown = e.type === 'plugin-event' ? (reaches(core, e, 'phone') ? e : null) : phoneAppEvent(e);
        if (shown) deliver(wire(shown));
      });
    Object.assign(globalThis, { window: {} });
    installApi(
      createPhoneRendererApi({
        call: async (call) => wire(await core.phone({ ...call, params: wire(call.params) })),
        listen: (fn) => void listeners.add(fn),
      }),
    );
  }
  return { audience: o.audience, received: () => [...received] };
};
