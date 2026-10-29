// Event fan-out shared by plugins and the host: one subscriber's throw or rejection is reported and never stops the others.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { definePreference, finiteOr } from '@plugin-sdk/shared';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { mainPreferences } from '../src/main/plugins/preferences';
import { PluginStates } from '../src/main/plugins/states';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const bridge = vi.hoisted(() => ({ emit: (_e: unknown): void => undefined }));
vi.mock('@/api', () => ({
  api: {
    onEvent: (listener: (e: unknown) => void) => {
      bridge.emit = listener;
      return () => undefined;
    },
  },
}));

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

describe("the renderer's app-event hub", () => {
  it('reports a throwing or rejecting subscriber and still delivers to every later one, event after event', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (err: unknown) => void reported.push(err));
    // Renderer module: imported by path so the node type-check doesn't follow it.
    const hubPath = '../src/plugin-sdk/renderer/appEvents';
    const { onAppEvent } = (await import(hubPath)) as { onAppEvent(type: AppEvent['type'], listener: (e: AppEvent) => unknown): () => void };
    const heard: string[] = [];
    onAppEvent('archive-changed', () => {
      throw new Error('plugin listener failed');
    });
    onAppEvent('archive-changed', () => Promise.reject(new Error('plugin listener rejected')));
    onAppEvent('archive-changed', () => void heard.push('host store'));
    onAppEvent('archive-changed', () => void heard.push('other plugin'));
    const event = { type: 'archive-changed', changes: { c: ['messages'] }, insertOnlyChannelIds: ['c'] } as AppEvent;
    expect(() => bridge.emit(event)).not.toThrow();
    bridge.emit(event);
    await flush();
    expect(heard).toEqual(['host store', 'other plugin', 'host store', 'other plugin']);
    expect(reported.map((err) => (err as Error).message).sort()).toEqual([
      'plugin listener failed',
      'plugin listener failed',
      'plugin listener rejected',
      'plugin listener rejected',
    ]);
    vi.unstubAllGlobals();
  });
});

describe("main's preference listeners", () => {
  const plugin = {
    manifest: { id: 'prefs', name: 'Prefs', version: '1.0.0', description: '' },
    preferences: { count: definePreference<number | null>({ default: null, normalize: finiteOr(null) }) },
  } satisfies PluginDescriptor;

  it("report a plugin callback's throw or rejection and let core's later event listeners run", async () => {
    const listeners: ((e: AppEvent) => void)[] = [];
    const core = { call: vi.fn(), on: (_name: 'event', fn: (e: AppEvent) => void) => void listeners.push(fn) };
    const failures: unknown[] = [];
    const prefs = mainPreferences(plugin, core as never, (apply) => apply(), (err) => void failures.push(err));
    prefs.onChange('count', () => {
      throw new Error('preference callback failed');
    });
    prefs.onChange('count', (() => Promise.reject(new Error('preference callback rejected'))) as never);
    const healthy: AppEvent[] = [];
    core.on('event', (e) => void healthy.push(e));
    const event: AppEvent = { type: 'setting-changed', key: 'plugin.prefs.count', value: 2 };
    expect(() => listeners.forEach((fn) => fn(event))).not.toThrow();
    await flush();
    expect(healthy).toEqual([event]);
    expect(failures.map((err) => (err as Error).message)).toEqual(['preference callback failed', 'preference callback rejected']);
  });
});

describe("main's plugin-state listeners (#266)", () => {
  it("report one listener's throw and still run the later ones", async () => {
    const failures: unknown[] = [];
    const states = new PluginStates(async () => [], (err) => void failures.push(err));
    let later = 0;
    states.onChange(() => {
      throw new Error('state listener failed');
    });
    states.onChange(() => void later++);
    await states.refresh();
    expect(later).toBe(1);
    expect(failures.map((err) => (err as Error).message)).toEqual(['state listener failed']);
  });
});