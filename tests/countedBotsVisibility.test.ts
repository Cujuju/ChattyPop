import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import type { AppEvent, ArchivedBot } from '@shared/contract';
import type { Resource } from 'solid-js';

const env = vi.hoisted(() => ({ read: vi.fn(async (): Promise<ArchivedBot[]> => []), event: undefined as ((event: AppEvent) => void) | undefined, visibility: undefined as (() => void) | undefined }));
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs'));
vi.mock('@/api', () => ({ api: { core: { archivedBots: env.read }, onEvent: (fn: (e: AppEvent) => void) => { env.event = fn; } } }));
vi.mock('../src/plugin-sdk/renderer/settings', () => ({ createSetting: () => [() => [], async () => {}, { loaded: Promise.resolve() }] }));
vi.mock('../src/renderer/src/state/events', async () => {
  const events = '../src/plugin-sdk/renderer/appEvents', archive = '../src/plugin-sdk/renderer/archiveEvents';
  return { ...(await import(events)), ...(await import(archive)) };
});

it('starts no bot reads while hidden and refreshes once when shown', async () => {
  const page = { visibilityState: 'hidden', addEventListener: (_name: string, fn: () => void) => { env.visibility = fn; } };
  vi.stubGlobal('document', page);
  vi.useFakeTimers();
  const path = '../src/renderer/src/state/countedBots';
  const { createArchivedBots } = await import(path);
  const { createRoot } = await import('solid-js');
  let dispose!: () => void;
  const bots = createRoot((end) => { dispose = end; return createArchivedBots(); }) as Resource<ArchivedBot[]>;
  try {
    env.event!({ type: 'archive-changed', changes: { c: ['edits'] }, insertOnlyChannelIds: [] });
    await vi.runAllTimersAsync();
    expect(env.read).not.toHaveBeenCalled();
    page.visibilityState = 'visible'; env.visibility!();
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledOnce();
    page.visibilityState = 'hidden'; env.visibility!();
    env.event!({ type: 'self-changed', userId: 'new-owner' });
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledOnce();
    page.visibilityState = 'visible'; env.visibility!();
    await vi.runAllTimersAsync();
    expect(env.read).toHaveBeenCalledTimes(2);
    let answerOld!: (value: ArchivedBot[]) => void;
    let answerVisible!: (value: ArchivedBot[]) => void;
    env.read
      .mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { answerVisible = resolve; }));
    page.visibilityState = 'hidden'; env.visibility!();
    page.visibilityState = 'visible'; env.visibility!();
    env.event!({ type: 'privacy-changed' });
    expect(bots()).toBeUndefined();
    answerOld([{ id: 'private', name: 'Private bot', username: 'private' }]);
    await vi.runAllTimersAsync();
    expect(bots()).toBeUndefined();
    expect(bots.loading).toBe(true);
    answerVisible([]);
    await vi.runAllTimersAsync();
    expect(bots()).toEqual([]);
  } finally { dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
