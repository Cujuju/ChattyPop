import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { archiveChange } from './archiveChangeFixture';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const source = vi.hoisted(() => ({ send: undefined as ((e: AppEvent) => void) | undefined }));
vi.mock('@/api', () => ({ api: { onEvent: (fn: (e: AppEvent) => void) => { source.send = fn; } } }));
const { createSignal } = await import('solid-js');
const path = '../src/plugin-sdk/renderer/archiveEvents';
const { onArchiveChange } = await import(path) as { onArchiveChange(deps: import('../src/plugin-sdk/renderer/archiveChangeSet').ArchiveDeps, fn: (change: import('../src/plugin-sdk/renderer/archiveChangeSet').ArchiveChangeSet, signal: AbortSignal) => unknown): () => void };
const eventPath = '../src/plugin-sdk/renderer/appEvents';
const { ARCHIVE_REFRESH_DEBOUNCE_MS } = await import(eventPath) as { ARCHIVE_REFRESH_DEBOUNCE_MS: number };
const disposers: (() => void)[] = [];
const send = (channel: string, kinds: Parameters<typeof archiveChange>[1] = ['messages'], inserts = false) => source.send!({ type: 'archive-changed', ...archiveChange(channel, kinds, inserts) });
const flush = () => vi.advanceTimersByTimeAsync(ARCHIVE_REFRESH_DEBOUNCE_MS);
beforeEach(() => vi.useFakeTimers());
afterEach(() => { disposers.splice(0).forEach((off) => off()); vi.useRealTimers(); });

describe('SDK archive refresh gate over a fake event source', () => {
  it('matches a parent channel and its threads, excluding other parents', async () => {
    const path = '../src/plugin-sdk/renderer/archiveScope';
    const { setArchiveDirectory } = await import(path);
    setArchiveDirectory([{ id: 'g', channels: [{ id: 'parent' }, { id: 'thread', parentId: 'parent' }, { id: 'other', parentId: 'elsewhere' }] }]);
    const read = vi.fn();
    disposers.push(onArchiveChange({ kinds: ['edits'], scope: () => ({ channelIds: ['parent'] }) }, read));
    send('other', ['edits']); await flush();
    expect(read).not.toHaveBeenCalled();
    send('thread', ['edits']); await flush();
    expect(read).toHaveBeenCalledOnce();
    expect([...read.mock.calls[0]![0].channelIds]).toEqual(['thread']);
  });

  it('reads nothing while hidden, then exactly once on show', async () => {
    const [shown, setShown] = createSignal(false);
    const read = vi.fn();
    disposers.push(onArchiveChange({ kinds: ['attachments'], shown }, read));
    send('c', ['attachments']); send('c', ['attachments']);
    await flush();
    expect(read).not.toHaveBeenCalled();
    setShown(true);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated kinds and channels outside its reactive scope', async () => {
    const [channel, setChannel] = createSignal('a');
    const read = vi.fn();
    disposers.push(onArchiveChange({ kinds: ['links'], scope: () => ({ channelIds: [channel()] }) }, read));
    send('a', ['reactions']); send('b', ['links']);
    await flush();
    expect(read).not.toHaveBeenCalled();
    setChannel('b'); send('b', ['links']);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst and retains the inserted range and mixed insert-only classification', async () => {
    const read = vi.fn();
    disposers.push(onArchiveChange({ kinds: ['messages', 'edits'] }, read));
    source.send!({ type: 'archive-changed', ...archiveChange('a', ['messages'], true), inserted: { afterSeq: 2, throughSeq: 4 } });
    source.send!({ type: 'archive-changed', ...archiveChange('b', ['messages'], true), inserted: { afterSeq: 4, throughSeq: 6 } });
    send('b', ['edits']);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    const change = read.mock.calls[0]![0];
    expect(change.insertOnly('a')).toBe(true);
    expect(change.insertOnly('b')).toBe(false);
    expect(change.inserted).toEqual({ afterSeq: 2, throughSeq: 6 });
  });

  it('aborts a superseded flight and performs exactly one merged rerun after it settles', async () => {
    let finish!: () => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    disposers.push(onArchiveChange({ kinds: ['messages', 'edits'] }, read));
    send('a', ['messages'], true); await flush();
    const signal = read.mock.calls[0]![1] as AbortSignal;
    send('b', ['edits']); send('c', ['messages'], true); await flush();
    expect(signal.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    finish(); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect([...read.mock.calls[1]![0].channelIds]).toEqual(['b', 'a', 'c']);
    await flush(); expect(read).toHaveBeenCalledTimes(2);
  });

  it('disposal aborts in-flight work and drops a queued refresh', async () => {
    let finish!: () => void;
    const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const off = onArchiveChange({ kinds: ['messages'] }, read);
    send('a'); await flush();
    send('b'); off();
    expect((read.mock.calls[0] as unknown as [unknown, AbortSignal])[1].aborted).toBe(true);
    finish(); await flush(); send('a'); await flush();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('resolves guild scopes from the shared directory and filters unrelated plugin writes', async () => {
    const scopePath = '../src/plugin-sdk/renderer/archiveScope';
    const { setArchiveDirectory } = await import(scopePath);
    setArchiveDirectory([{ id: 'g', channels: [{ id: 'c' }] }, { id: 'other', channels: [{ id: 'outside' }] }]);
    const read = vi.fn();
    disposers.push(onArchiveChange({ kinds: ['links', 'plugin'], scope: () => ({ guildIds: ['g'] }), pluginIds: ['plans'] }, read));
    send('outside', ['links']);
    source.send!({ type: 'archive-changed', ...archiveChange('c', ['plugin']), pluginIds: ['unrelated'] });
    await flush(); expect(read).not.toHaveBeenCalled();
    send('c', ['links']); await flush(); expect(read).toHaveBeenCalledTimes(1);
  });

});
