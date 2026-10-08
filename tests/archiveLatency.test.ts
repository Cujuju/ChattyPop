import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, ArchiveMessage, MessageWindow } from '@shared/contract';
import { ArchiveChanges } from '@shared/archiveChanges';
import { postedArchiveMessage } from '@shared/postedMessage';
import { acceptedMessage } from './postedMessageFixture';
import { sentRows } from '../src/renderer/src/state/outboxSent';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const env = vi.hoisted(() => ({ page: vi.fn(), window: vi.fn(), listeners: new Map<string, (e: AppEvent) => Promise<void>>() }));
vi.mock('@/api', () => ({ api: { core: { messagePage: env.page, messageWindow: env.window }, discord: { shownChannel: async () => null } } }));
vi.mock('../src/renderer/src/state/events', () => ({
  onAppEvent: (type: string, handler: (e: AppEvent) => Promise<void>) => env.listeners.set(type, handler),
  onMessagePartsChanged: () => {},
}));
vi.mock('../src/renderer/src/state/ui', () => ({ inCompanion: true, inPanelWindow: false }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => ({}), refetchDirectory: async () => {} }));
vi.mock('../src/renderer/src/state/chat', () => ({ chatSource: () => 'archive', setChatSource: () => {} }));
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = await import('solid-js');
  return { createSetting: (_key: string, initial: unknown) => [...createSignal(initial), { loaded: Promise.resolve() }] };
});

const archivePath = '../src/renderer/src/state/archive';
const { archiveState, openArchive, openArchiveAt, atNewest } = await import(archivePath);
const CHANNEL = '200000000000000001';
const FIRST = '1420000000000000000';
const SECOND = '1420000000000000001';
const row = (id: string): ArchiveMessage => ({
  ...postedArchiveMessage(acceptedMessage({ channelId: CHANNEL, text: id, nonce: id, files: [], replyTo: null, stickerId: null, gif: null }).message, id), id,
});
const event = (insertOnly: boolean): AppEvent => ({ type: 'archive-changed', channelIds: [CHANNEL], ...(insertOnly ? { insertOnlyChannelIds: [CHANNEL] } : {}) });
const change = (insertOnly: boolean) => env.listeners.get('archive-changed')!(event(insertOnly));

beforeEach(async () => {
  env.page.mockReset();
  env.window.mockReset().mockResolvedValue({ items: [row(FIRST)], reachesNewest: true } satisfies MessageWindow);
  await openArchive(CHANNEL);
  env.page.mockClear();
  env.window.mockClear();
});

describe('archive arrival and restore latency', () => {
  it('reads only catch-up for inserts, while preserving the raw database cursor', async () => {
    env.page.mockResolvedValue([row(SECOND)]);
    await change(true);
    expect(env.page.mock.calls).toEqual([[{ channelId: CHANNEL, limit: 100, after: FIRST }]]);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST, SECOND]);
  });

  it.each(['edit', 'delete'])('refreshes existing rows for an %s after catch-up', async (kind) => {
    env.page.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...row(FIRST), content: 'updated', deletedAt: kind === 'delete' ? Date.now() : null }]);
    await change(false);
    expect(env.page.mock.calls).toEqual([
      [{ channelId: CHANNEL, limit: 100, after: FIRST }], [{ channelId: CHANNEL, limit: 100 }],
    ]);
    expect(archiveState.items[0]?.content).toBe('updated');
    expect(archiveState.items[0]?.deletedAt !== null).toBe(kind === 'delete');
  });

  it('reads the newest page for a previously empty channel', async () => {
    env.window.mockResolvedValue({ items: [], reachesNewest: true });
    await openArchive(CHANNEL);
    env.page.mockResolvedValue([row(FIRST)]);
    await change(true);
    expect(env.page.mock.calls).toEqual([[{ channelId: CHANNEL, limit: 100 }]]);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST]);
  });

  it('serializes overlapping arrival reads so later inserts cannot fall behind an older snapshot', async () => {
    let resolve!: (page: ArchiveMessage[]) => void;
    env.page.mockReturnValueOnce(new Promise<ArchiveMessage[]>((r) => { resolve = r; })).mockResolvedValueOnce([row(SECOND)]);
    const first = change(true);
    await vi.waitFor(() => expect(env.page).toHaveBeenCalledTimes(1));
    const later = change(true);
    expect(env.page).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([first, later]);
    expect(env.page).toHaveBeenCalledTimes(2);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST, SECOND]);
  });

  it('does not use an accepted but unarchived row as its catch-up cursor', async () => {
    const accepted = acceptedMessage({ channelId: CHANNEL, text: 'sent', nonce: SECOND, files: [], replyTo: null, stickerId: null, gif: null });
    sentRows.accept({ ...accepted, message: { ...accepted.message, id: SECOND } });
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST, SECOND]);
    env.page.mockResolvedValue([row(SECOND)]);
    await change(true);
    expect(env.page.mock.calls).toEqual([[{ channelId: CHANNEL, limit: 100, after: FIRST }]]);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST, SECOND]);
  });

  it('waits for an in-flight restore before reading an insert arriving during it', async () => {
    let resolve!: (page: MessageWindow) => void;
    env.window.mockReturnValueOnce(new Promise<MessageWindow>((r) => { resolve = r; }));
    const opening = openArchive(CHANNEL);
    env.page.mockResolvedValue([row(SECOND)]);
    const arrival = change(true);
    await Promise.resolve();
    expect(env.page).not.toHaveBeenCalled();
    resolve({ items: [row(FIRST)], reachesNewest: true });
    await Promise.all([opening, arrival]);
    expect(env.page).toHaveBeenCalledTimes(1);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST, SECOND]);
  });

  it('restores the page and reachesNewest through one RPC', async () => {
    env.window.mockResolvedValue({ items: [row(FIRST)], reachesNewest: false });
    await openArchiveAt({ channelId: CHANNEL, messageId: FIRST, bottom: 0 });
    expect(env.window.mock.calls).toEqual([[{ channelId: CHANNEL, limit: 100, around: FIRST }]]);
    expect(env.page).not.toHaveBeenCalled();
    expect(atNewest()).toBe(false);
    expect(archiveState.items.map((m: ArchiveMessage) => m.id)).toEqual([FIRST]);
  });
});

describe('archive change batches', () => {
  it('marks only proved insert-only channels, regardless of write order', () => {
    const batch = new ArchiveChanges();
    batch.add('insert', true);
    batch.add('edited', false);
    batch.add('edited', true);
    batch.add('deleted', true);
    batch.add('deleted', false);
    expect(batch.take()).toEqual({ channelIds: ['insert', 'edited', 'deleted'], insertOnlyChannelIds: ['insert'] });
    expect(batch.take()).toEqual({ channelIds: [], insertOnlyChannelIds: [] });
  });
});
