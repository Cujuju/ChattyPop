import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { changeSet } from '../src/plugin-sdk/renderer/archiveChangeSet';
import { archiveChange } from './archiveChangeFixture';
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const path = '../src/renderer/src/state/paged';
const { createPagedList } = await import(path) as typeof import('../src/renderer/src/state/paged');
/** A page larger than the fixture proves catch-up stops after one short newer read. */
const PAGE_SIZE = 10;
const inserted = changeSet(archiveChange('c', ['messages'], true));

describe('paged change application', () => {
  it('reads newer once for inserts, reloads for edits, and reloads for non-chronological order', async () => {
    const first = vi.fn(async () => ({ items: [{ id: 'old' }], reachedStart: true }));
    const newer = vi.fn(async () => [{ id: 'new' }]);
    let chronological = true;
    const list = createPagedList(PAGE_SIZE, async () => [], newer, { chronological: () => chronological });
    await list.reload(first); first.mockClear();
    await list.applyChange(inserted);
    expect(newer).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled();
    expect(list.state.items.map((row) => row.id)).toEqual(['old', 'new']);
    await list.applyChange(changeSet(archiveChange('c', ['edits'])));
    expect(first).toHaveBeenCalledTimes(1);
    chronological = false;
    await list.applyChange(inserted);
    expect(first).toHaveBeenCalledTimes(2); expect(newer).toHaveBeenCalledTimes(1);
  });

  it('prepends inserts to descending Person lists and pages older from their oldest cursor', async () => {
    const older = vi.fn(async () => [{ id: 'oldest' }]);
    const newer = vi.fn(async () => [{ id: 'newest' }]);
    const list = createPagedList(PAGE_SIZE, older, undefined, { newestAtStart: () => true, oldestAtEnd: true, newer });
    await list.reload(async () => ({ items: [{ id: 'new' }, { id: 'old' }], reachedStart: false }));
    await list.applyChange(inserted); await list.loadOlder();
    expect(newer).toHaveBeenCalledWith({ id: 'new' }, expect.any(AbortSignal));
    expect(older).toHaveBeenCalledWith({ id: 'old' }, expect.any(AbortSignal));
    expect(list.state.items.map((row) => row.id)).toEqual(['newest', 'new', 'old', 'oldest']);
  });
  it('cannot restore rows cleared by a privacy reset while a first-page read is pending', async () => {
    let answer!: (value: { items: { id: string }[]; reachedStart: boolean }) => void;
    const list = createPagedList<{ id: string }>(PAGE_SIZE, async () => []);
    const pending = list.reload(() => new Promise((resolve) => { answer = resolve; }));
    list.reset();
    answer({ items: [{ id: 'private' }], reachedStart: true });
    expect(await pending).toBe(false);
    expect(list.state.items).toEqual([]);
  });

  it('carries gate cancellation through a second incremental page', async () => {
    const controller = new AbortController();
    let pages = 0;
    let active: AbortSignal | undefined;
    const list = createPagedList<{ id: string }>(1, async () => [], async (_edge, signal) => {
      if (++pages === 1) return [{ id: 'new' }];
      active = signal;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    await list.reload(async () => ({ items: [{ id: 'old' }], reachedStart: true }));
    const pending = list.applyChange(inserted, controller.signal);
    const outcome = pending.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(pages).toBe(2);
    controller.abort(new Error('gate superseded'));
    expect(active!.aborted).toBe(true);
    expect(await outcome).toBe(controller.signal.reason);
    expect(list.state.items.map((row) => row.id)).toEqual(['old', 'new']);
  });

});
