// Paged lists read only while shown: their core calls take the interactive lane and are cancelled when the list hides.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const calls = vi.hoisted(() => ({ made: [] as { priority: string }[], cancelled: [] as string[] }));
vi.mock('@/api', () => ({ api: { plugins: {
  callCore: (_plugin: string, _member: string, _args: unknown[], request: { id: string; priority: string }) => {
    calls.made.push(request);
    return new Promise(() => undefined);
  },
  cancelCore: async (_plugin: string, id: string) => { calls.cancelled.push(id); },
} } }));
const { createPagedList } = await import('../src/renderer/src/state/paged');
// A renderer module: imported by path so the node type-check doesn't follow it.
const callPath = '../src/plugin-sdk/renderer/call';
const { callCore } = (await import(callPath)) as { callCore(plugin: string, member: string, args: unknown[]): Promise<unknown> };
const { createRoot, createSignal } = await import('solid-js');

describe('paged list core calls', () => {
  it('run at interactive priority and are cancelled when the list hides', async () => {
    const [shown, setShown] = createSignal(true);
    const list = createRoot(() => createPagedList<{ id: number }>(20, async () => [], undefined, { shown }));
    const pending = list.reload(async () => ({ items: (await callCore('p', 'page', [])) as { id: number }[], reachedStart: true }));
    expect(calls.made).toEqual([expect.objectContaining({ priority: 'interactive' })]);
    setShown(false);
    await expect(pending).resolves.toBe(false);
    expect(calls.cancelled).toEqual([(calls.made[0] as unknown as { id: string }).id]);
  });
});
