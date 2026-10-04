// The renderer's app-event hub and plugin list are one instance each (docs/plugin-architecture.md §8): the SDK owns
// them and host stores build on them, so one subscription and one fetch serve every reader.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';

const probe = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' } });

// The client runtime, so resources load as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  subscriptions: 0,
  fetches: 0,
  on: true,
  emit: null as null | ((e: { type: string }) => void),
}));

// A desktop window's API, counting event subscriptions and plugin list fetches.
vi.stubGlobal('window', {
  chattypop: {
    onEvent: (listener: (e: { type: string }) => void) => {
      env.subscriptions++;
      env.emit = listener;
      return () => undefined;
    },
    core: {
      plugins: async () => {
        env.fetches++;
        return [{ id: probe.manifest.id, bundled: true, status: env.on ? 'active' : 'disabled' }];
      },
    },
  },
});

/** Lets awaited continuations and resource loads run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

type Listen = (type: 'plugins-changed', listener: () => void) => () => void;
interface Readers {
  onAppEvent: Listen;
}
// Renderer modules: imported by path so the node type-check doesn't follow them.
const hostEventsPath = '../src/renderer/src/state/events';
const hostPluginsPath = '../src/renderer/src/state/plugins';
const sdkPath = '../src/plugin-sdk/renderer/index';

describe('renderer shared state', () => {
  it('one event subscription and one plugin list fetch serve host stores and the SDK alike', async () => {
    const hostEvents = (await import(hostEventsPath)) as Readers;
    const hostPlugins = (await import(hostPluginsPath)) as { pluginActive(id: string): boolean; plugins(): unknown[] };
    const sdk = (await import(sdkPath)) as Readers & { isActive(p: typeof probe): boolean };
    await settle();
    expect(env.subscriptions).toBe(1);
    expect(env.fetches).toBe(1);
    expect(hostPlugins.pluginActive(probe.manifest.id)).toBe(true);
    expect(sdk.isActive(probe)).toBe(true);

    // One event reaches both readers' listeners; the list re-reads once, for both.
    const heard: string[] = [];
    hostEvents.onAppEvent('plugins-changed', () => heard.push('host'));
    sdk.onAppEvent('plugins-changed', () => heard.push('sdk'));
    env.on = false;
    env.emit!({ type: 'plugins-changed' });
    await settle();
    expect(heard).toEqual(['host', 'sdk']);
    expect(env.subscriptions).toBe(1);
    expect(env.fetches).toBe(2);
    expect(hostPlugins.pluginActive(probe.manifest.id)).toBe(false);
    expect(sdk.isActive(probe)).toBe(false);
  });
});
