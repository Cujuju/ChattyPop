// Plugin inactivity crosses message-only transports and settles renderer data refetches without rejection.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { clientOver } from '@shared/pluginChannels';
import { PluginInactiveError, pluginCallResult, type PluginCallResult } from '@shared/pluginCall';
import { decodeWire, encodeWire } from '@plugin-sdk/shared';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { PluginHost } from '../src/core/plugins/host';
import { pluginHandlers } from '../src/core/serviceHandlers';
import { pluginData } from '../src/plugin-sdk/renderer/data';
import { tempDb, tempDir } from './helpers';

// Load Solid's client runtime explicitly: resources refetch in windows, not in the Node SSR runtime.
const { createRoot, createResource, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
const plugin = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  channels: defineChannels<{ core: { read(): string[] }; main: { read(): string[] } }>()({
    core: { read: { audiences: ['renderer', 'phone', 'main'], writes: false } }, main: { read: ['renderer'] },
  }),
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
// A renderer module (it imports @/api): imported by path so the node type-check doesn't follow it.
const CLIENTS = '../src/plugin-sdk/renderer/clients';
type ProbeClient = { read(): Promise<string[]> };
const { coreClient, mainClient } = (await import(CLIENTS)) as { coreClient(p: typeof plugin): ProbeClient; mainClient(p: typeof plugin): ProbeClient };

async function start() {
  const dir = tempDir();
  const folder = join(dir, 'probe');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ id: 'probe', version: '1', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
  writeFileSync(join(folder, 'main.mjs'), `export function activate(api) {
    api.rpc.handle('read', () => ['loaded']);
    api.rpc.handle('fail', () => { throw new Error('read failed'); });
  }`);
  const host = new PluginHost(dir, { db: tempDb(), emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null });
  await host.loadAll();
  const handlers = pluginHandlers(() => host);
  const callCore = (id: string, name: string, args: unknown[]) => handlers.pluginCall('renderer', id, name, args).then(structuredClone);
  vi.stubGlobal('window', { chattypop: { plugins: { callCore, callMain: callCore } } });
  return host;
}

afterEach(() => vi.unstubAllGlobals());

describe('inactive plugin calls', () => {
  it('distinguishes inactive plugins from unknown members, forbidden audiences and real failures', async () => {
    const host = await start();
    await expect(host.call('renderer', 'probe', 'missing', [])).rejects.toThrow('has no function missing');
    await expect(host.call('phone', 'probe', 'read', [])).rejects.toThrow('has no function read for phone');
    await expect(host.call('renderer', 'probe', 'fail', [])).rejects.toThrow('read failed');
    await host.setEnabled('probe', false);
    await expect(host.call('renderer', 'probe', 'read', [])).rejects.toBeInstanceOf(PluginInactiveError);
    await expect(pluginHandlers(() => host).pluginCall('renderer', 'probe', 'read', [])).resolves.toEqual({ status: 'inactive', pluginId: 'probe' });
    await expect(host.call('renderer', 'removed', 'read', [])).rejects.toThrow('has no function read');
  });

  it('renderer core and main clients decode envelopes and preserve other rejections', async () => {
    const host = await start();
    const core = coreClient(plugin);
    await expect(core.read()).resolves.toEqual(['loaded']);
    await expect(mainClient(plugin).read()).resolves.toEqual(['loaded']);
    await host.setEnabled('probe', false);
    await expect(core.read()).rejects.toMatchObject({ name: 'PluginInactiveError', pluginId: 'probe' });
    await expect(mainClient(plugin).read()).rejects.toBeInstanceOf(PluginInactiveError);
    await host.setEnabled('probe', true);
    await expect(core.read()).resolves.toEqual(['loaded']);
  });

  it.each(['worker', 'ipc', 'phone'] as const)('keeps the inactive condition and successful payloads distinct over %s serialization', async (transport) => {
    const wire = (result: PluginCallResult): PluginCallResult => transport === 'phone'
      ? decodeWire(encodeWire(result)) as PluginCallResult : structuredClone(result);
    let inactive = false;
    const payload = { status: 'inactive', pluginId: 'ordinary payload' };
    const client = clientOver<{ read(): Promise<unknown> }>(() => pluginCallResult(() => {
      if (inactive) throw new PluginInactiveError('probe');
      return payload;
    }).then(wire));
    await expect(client.read()).resolves.toEqual(payload);
    inactive = true;
    await expect(client.read()).rejects.toBeInstanceOf(PluginInactiveError);
  });

  it('uses only the typed inactive condition for fallback, preserving every other error object', async () => {
    const fallback: string[] = [];
    await expect(pluginData(() => Promise.reject(new PluginInactiveError('probe')), fallback)).resolves.toBe(fallback);
    const failure = new Error('Plugin probe is not active');
    await expect(pluginData(() => Promise.reject(failure), fallback)).rejects.toBe(failure);
    await expect(pluginCallResult(() => { throw failure; })).rejects.toBe(failure);
    await expect(pluginData(async () => ['loaded'], fallback)).resolves.toEqual(['loaded']);
  });

  it('settles an unawaited probe resource refetch after core stops, before the renderer learns it stopped', async () => {
    const host = await start();
    const core = coreClient(plugin);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const store = createRoot((dispose) => {
      const [active] = createSignal(true);
      const [rows, { refetch }] = createResource(active, () => pluginData(() => core.read(), []), { initialValue: [] });
      return { rows, refetch, active, dispose };
    });
    try {
      await vi.waitFor(() => expect(store.rows()).toEqual(['loaded']));
      await host.setEnabled('probe', false);
      expect(store.active()).toBe(true);
      void store.refetch();
      await vi.waitFor(() => expect(store.rows()).toEqual([]));
      expect(store.rows.state).toBe('ready');
      expect(store.rows.error).toBeUndefined();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      store.dispose();
      process.off('unhandledRejection', unhandled);
    }
  });
});
