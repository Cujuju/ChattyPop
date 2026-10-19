import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import type { DirectoryGuild } from '@shared/contract';
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const env = vi.hoisted(() => ({ read: vi.fn<() => Promise<DirectoryGuild[]>>() }));
vi.mock('@/api', () => ({ api: { core: { directory: env.read } } }));
vi.mock('../src/renderer/src/state/events', () => ({ onArchiveChange: () => {}, onAppEvent: () => {} }));

it('contains a synchronous bridge failure on the initial directory read and recovers on the next read', async () => {
  const failed = new Error('Bridge unavailable');
  const reported = vi.fn();
  vi.stubGlobal('reportError', reported);
  env.read.mockImplementationOnce(() => { throw failed; });
  try {
    const path = '../src/renderer/src/state/directory';
    const { directory, refetchDirectory } = await import(path) as { directory(): DirectoryGuild[]; refetchDirectory(): Promise<DirectoryGuild[]> };
    await new Promise((resolve) => setTimeout(resolve));
    expect(directory()).toEqual([]);
    expect(reported).toHaveBeenCalledExactlyOnceWith(failed);
    env.read.mockResolvedValueOnce([]);
    await expect(refetchDirectory()).resolves.toEqual([]);
    expect(directory()).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});
