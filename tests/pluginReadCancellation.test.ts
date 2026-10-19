import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import type { PluginCallResult } from '../src/shared/pluginCall';
import type { PluginCallRequest } from '../src/shared/readPriority';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const transport = vi.hoisted(() => ({
  calls: [] as { args: unknown[]; request: PluginCallRequest; resolve(reply: PluginCallResult): void }[],
  cancel: vi.fn(async (_plugin: string, _id: string) => undefined),
}));
vi.mock('@/api', () => ({
  windowAudience: () => 'renderer',
  api: { plugins: {
    callCore: (_plugin: string, _member: string, args: unknown[], request: PluginCallRequest) => new Promise<PluginCallResult>((resolve) => transport.calls.push({ args, request, resolve })),
    cancelCore: transport.cancel,
  } },
}));
vi.mock('@plugin-sdk/renderer/pluginList', () => ({ callable: () => true }));
const solid = await import('solid-js');
const resourcePath = '../src/plugin-sdk/renderer/resource';
const callsPath = '../src/plugin-sdk/renderer/call';
const clientsPath = '../src/plugin-sdk/renderer/clients';
const coalescedPath = '../src/plugin-sdk/renderer/coalescedRead';
const { pluginResource } = await import(resourcePath) as { pluginResource(plugin: unknown, member: string, args: () => number[], fallback: number[], options?: { shown(): boolean }): () => number[] };
const { withCallOptions } = await import(callsPath) as { withCallOptions<T>(options: { signal: AbortSignal; priority: 'background' }, run: () => T): T };
const { desktopCoreClient } = await import(clientsPath) as { desktopCoreClient(plugin: unknown, options?: { signal: AbortSignal; priority: 'background' }): { rows(n: number): Promise<number[]> } };
const { coalescedRead } = await import(coalescedPath) as { coalescedRead(read: (signal?: AbortSignal) => Promise<number[]>, key: () => string): (signal?: AbortSignal) => Promise<number[]> };
const probe = definePlugin({
  manifest: { id: 'cancels', name: 'Cancels', version: '1', description: '' },
  channels: defineChannels<{ core: { rows(n: number): number[] } }>()({ core: { rows: { audiences: ['renderer'], reads: true } } }),
});
const disposers: (() => void)[] = [];
/** Drains the resource's coalesced request and promise-finally chain without wall-clock timing. */
const settle = async () => { for (let i = 0; i < RESOURCE_MICROTASKS; i++) await Promise.resolve(); };
const RESOURCE_MICROTASKS = 20;
afterEach(() => { disposers.splice(0).forEach((off) => off()); transport.calls.length = 0; transport.cancel.mockClear(); });

describe('renderer read cancellation', () => {
  it('coalesces only callers with the same cancellation signal', async () => {
    const a = new AbortController(), b = new AbortController();
    const read = vi.fn(async (_signal?: AbortSignal) => [] as number[]);
    const shared = coalescedRead(read, () => 'same-key');
    const first = shared(a.signal);
    expect(shared(a.signal)).toBe(first);
    expect(shared(b.signal)).not.toBe(first);
    expect(shared()).not.toBe(first);
    await first;
    expect(shared(a.signal)).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('sends distinct ids and cancels a superseded resource and its disposed replacement', async () => {
    const [arg, setArg] = solid.createSignal(1);
    const resource = solid.createRoot((dispose) => { disposers.push(dispose); return pluginResource(probe, 'rows', () => [arg()], []); });
    await settle();
    const first = transport.calls[0]!;
    expect(first.request.priority).toBe('interactive');
    setArg(2);
    await settle();
    expect(transport.cancel).toHaveBeenCalledWith('cancels', first.request.id);
    const second = transport.calls[1]!;
    expect(second.args).toEqual([2]);
    expect(second.request.id).not.toBe(first.request.id);
    first.resolve({ status: 'ok', value: [1] });
    await settle();
    expect(resource()).toEqual([]);
    disposers.pop()!();
    expect(transport.cancel).toHaveBeenCalledWith('cancels', second.request.id);
    second.resolve({ status: 'ok', value: [2] });
    await settle();
    expect(resource()).toEqual([]);
  });

  it('does not read while hidden, and cancels immediately when hidden during a read', async () => {
    const [shown, setShown] = solid.createSignal(false);
    solid.createRoot((dispose) => { disposers.push(dispose); pluginResource(probe, 'rows', () => [1], [], { shown }); });
    await settle();
    expect(transport.calls).toHaveLength(0);
    setShown(true);
    await settle();
    expect(transport.calls).toHaveLength(1);
    setShown(false);
    expect(transport.cancel).toHaveBeenCalledWith('cancels', transport.calls[0]!.request.id);
  });

  it('binds gate calls and explicit calls after awaits to the same signal and priority', async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, priority: 'background' as const };
    const first = withCallOptions(options, () => desktopCoreClient(probe).rows(1));
    const firstResult = first.catch((error: unknown) => error);
    await Promise.resolve();
    const second = desktopCoreClient(probe, options).rows(2);
    const secondResult = second.catch((error: unknown) => error);
    controller.abort(new Error('superseded gate'));
    expect(await firstResult).toBe(controller.signal.reason);
    expect(await secondResult).toBe(controller.signal.reason);
    expect(transport.calls.map((call) => call.request.priority)).toEqual(['background', 'background']);
    expect(transport.cancel.mock.calls.map((args) => args[1])).toEqual(transport.calls.map((call) => call.request.id));
    await expect(desktopCoreClient(probe, options).rows(3)).rejects.toBe(controller.signal.reason);
    expect(transport.calls).toHaveLength(2);
  });
});
