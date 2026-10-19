import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

const env = vi.hoisted(() => ({ read: vi.fn(async () => []), event: undefined as ((event: AppEvent) => void) | undefined, visibility: undefined as (() => void) | undefined }));
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs'));
vi.mock('@/api', () => ({ api: { core: { archivedBots: env.read }, onEvent: (fn: (e: AppEvent) => void) => { env.event = fn; } } }));
vi.mock('../src/plugin-sdk/renderer/settings', () => ({ createSetting: () => [() => [], async () => {}, { loaded: Promise.resolve() }] }));
vi.mock('../src/renderer/src/state/events', async () => ({
  ...(await import('../src/plugin-sdk/renderer/appEvents')),
  ...(await import('../src/plugin-sdk/renderer/archiveEvents')),
}));

it('starts no bot reads while hidden and refreshes once when shown', async () => {
  const page = { visibilityState: 'hidden', addEventListener: (_name: string, fn: () => void) => { env.visibility = fn; } };
  vi.stubGlobal('document', page);
  vi.useFakeTimers();
  const path = '../src/renderer/src/state/countedBots';
  const { createArchivedBots } = await import(path);
  const { createRoot } = await import('solid-js');
  let dispose!: () => void;
  createRoot((end) => { dispose = end; createArchivedBots(); });
  try {
    env.event!({ type: 'archive-changed', changes: { c: ['edits'] }, insertOnlyChannelIds: [] });
    await vi.runAllTimersAsync();
    expect(env.read).not.toHaveBeenCalled();
    page.visibilityState = 'visible'; env.visibility!();
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledOnce();
    page.visibilityState = 'hidden'; env.visibility!();
    env.event!({ type: 'self-changed', self: null } as AppEvent);
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledOnce();
    page.visibilityState = 'visible'; env.visibility!();
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledTimes(2);
  } finally { dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
