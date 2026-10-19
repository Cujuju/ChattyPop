import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { changeSet } from '../src/plugin-sdk/renderer/archiveChangeSet';
import { archiveChange } from './archiveChangeFixture';
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createPagedList } = await import('../src/renderer/src/state/paged');
const { createRoot, createSignal } = await import('solid-js');
const inserted = changeSet(archiveChange('c', ['messages'], true));
const initial = { items: [{ id: 'kept' }], reachedStart: false };
const modes = ['reload', 'older', 'newer', 'update', 'change'] as const;

describe('paged cancellation is a normal completion', () => {
  it.each(modes)('settles a rejected %s read on hide without dropping rows or reporting a failure', async (mode) => {
    const [shown, setShown] = createSignal(true);
    let dispose!: () => void;
    const fetch = (_row: { id: string }, signal?: AbortSignal): Promise<{ id: string }[]> =>
      new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    const list = createRoot((end) => { dispose = end; return createPagedList(10, fetch, fetch, { shown }); });
    try {
      await list.reload(async () => initial);
      const pending = mode === 'reload' ? list.reload(async (signal) => ({ ...initial, items: await fetch(initial.items[0]!, signal) }))
        : mode === 'older' ? list.loadOlder() : mode === 'newer' ? list.loadNewer()
        : mode === 'update' ? list.update((signal) => fetch(initial.items[0]!, signal), (rows) => rows)
        : list.applyChange(inserted);
      setShown(false);
      await expect(pending).resolves.toBe(mode === 'reload' || mode === 'update' ? false : mode === 'older' ? 0 : mode === 'newer' ? null : undefined);
      expect(list.state.items).toEqual(initial.items);
      expect(list.state.loading).toBe(false);
    } finally { dispose(); }
  });

  it('settles superseded and pre-cancelled reloads and retains the latest successful rows', async () => {
    const list = createPagedList<{ id: string }>(10, async () => []);
    const old = list.reload((signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })));
    await expect(list.reload(async () => initial)).resolves.toBe(true);
    await expect(old).resolves.toBe(false);
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async () => ({ items: [], reachedStart: true }));
    await expect(list.reload(read, controller.signal)).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(list.state.items).toEqual(initial.items);
  });

  it.each(modes)('still rejects a real %s failure', async (mode) => {
    const failed = new Error('Archive unavailable');
    const fetch = async (): Promise<{ id: string }[]> => { throw failed; };
    const list = createPagedList(10, fetch, fetch);
    await list.reload(async () => initial);
    const pending = mode === 'reload' ? list.reload(fetch as never)
      : mode === 'older' ? list.loadOlder() : mode === 'newer' ? list.loadNewer()
      : mode === 'update' ? list.update(fetch, (rows) => rows) : list.applyChange(inserted);
    await expect(pending).rejects.toBe(failed);
    expect(list.state.loading).toBe(false);
  });
});
