// The Archive's loaded rows follow archive changes wherever the window sits, and stay one unbroken stretch of the channel.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, ArchiveMessage, MessagePageQuery, MessageWindow } from '@shared/contract';
import { postedArchiveMessage } from '@shared/postedMessage';
import { acceptedMessage } from './postedMessageFixture';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
/** The channel's archived rows, oldest first, as core reads them. */
const env = vi.hoisted(() => ({ rows: [] as ArchiveMessage[], listeners: new Map<string, (e: AppEvent) => Promise<void>>() }));

function page(q: MessagePageQuery): ArchiveMessage[] {
  const rows = env.rows;
  const at = (id: string): number => rows.findIndex((m) => m.id === id);
  if (q.around) {
    const i = at(q.around);
    const half = Math.ceil(q.limit / 2);
    return rows.slice(Math.max(0, i - half + 1), i + 1 + q.limit - half);
  }
  if (q.before) return rows.slice(0, at(q.before)).slice(-q.limit);
  if (q.after) return rows.slice(at(q.after) + 1, at(q.after) + 1 + q.limit);
  return rows.slice(-q.limit);
}
vi.mock('@/api', () => ({
  api: {
    core: {
      messagePage: async (q: MessagePageQuery) => page(q),
      messageWindow: async (q: MessagePageQuery): Promise<MessageWindow> => {
        const items = page(q);
        return { items, reachesNewest: items.at(-1)?.id === env.rows.at(-1)?.id };
      },
      messagesByIds: async (ids: string[]) => env.rows.filter((m) => ids.includes(m.id)),
    },
    discord: { shownChannel: async () => null },
  },
}));
vi.mock('../src/renderer/src/state/events', async () => { const { archiveListener } = await import('./archiveChangeFixture'); return ({
  onArchiveChange: (deps: import('../src/plugin-sdk/renderer/archiveChangeSet').ArchiveDeps, fn: (c: import('../src/plugin-sdk/renderer/archiveChangeSet').ArchiveChangeSet, signal: AbortSignal) => unknown) => env.listeners.set('archive-changed', archiveListener(deps, fn) as never),
  onAppEvent: (type: string, handler: (e: AppEvent) => Promise<void>) => env.listeners.set(type, handler),
  onMessagePartsChanged: () => {},
}); });
vi.mock('../src/renderer/src/state/ui', () => ({ inCompanion: true, inPanelWindow: false }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => ({}), refetchDirectory: async () => {} }));
vi.mock('../src/renderer/src/state/chat', () => ({ chatSource: () => 'archive', setChatSource: () => {} }));
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = await import('solid-js');
  return { createSetting: (_key: string, initial: unknown) => [...createSignal(initial), { loaded: Promise.resolve() }] };
});

// A variable path keeps the renderer module (its `@/` imports) out of the node type-check.
const ARCHIVE = '../src/renderer/src/state/archive';
const archive = (await import(ARCHIVE)) as {
  archiveState: { items: ArchiveMessage[] };
  openArchive(channelId: string, messageId?: string): Promise<void>;
  loadOlder(): Promise<number>;
  loadNewer(): Promise<void>;
  atNewest(): boolean;
};
const CHANNEL = '200000000000000001';
/** Messages per Archive page, as archive.ts reads them. */
const PAGE = 100;
/** archive.ts's catch-up budget: pages one change reads at most. */
const CATCH_UP_PAGES = 100;
const base = postedArchiveMessage(acceptedMessage({ channelId: CHANNEL, text: '', nonce: '0', files: [], replyTo: null, stickerId: null, gif: null }).message, '0');
/** Message `n` of the channel: ids and times rise with n. */
const row = (n: number): ArchiveMessage => ({ ...base, id: String(n), ts: n, content: `m${n}` });
const rows = (from: number, to: number): ArchiveMessage[] => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
const shown = (): number[] => archive.archiveState.items.map((m) => Number(m.id));
const change = (insertOnly = false): Promise<void> =>
  env.listeners.get('archive-changed')!({ type: 'archive-changed', changes: { [CHANNEL]: [insertOnly ? 'messages' : 'edits'] }, insertOnlyChannelIds: insertOnly ? [CHANNEL] : [] });
/** Edits message `n` in the archive and marks it deleted. */
const editAndDelete = (n: number): void => {
  env.rows = env.rows.map((m) => (m.id === String(n) ? { ...m, content: 'edited on Discord', deletedAt: 42 } : m));
};
const shownRow = (n: number): ArchiveMessage | undefined => archive.archiveState.items.find((m) => m.id === String(n));
/** Every shown row follows the one before it in the channel, with none between them. */
const unbroken = (): boolean => shown().every((n, i, all) => i === 0 || n === all[i - 1]! + 1);

beforeEach(() => {
  env.rows = [];
});

describe('loaded rows follow archive changes', () => {
  it('in a window opened around an older message', async () => {
    env.rows = rows(1, 1000);
    await archive.openArchive(CHANNEL, '10');
    expect(archive.atNewest()).toBe(false);
    editAndDelete(10);
    await change();
    expect(shownRow(10)).toMatchObject({ content: 'edited on Discord', deletedAt: 42 });
  });

  it('on an older loaded page of a window at the newest', async () => {
    env.rows = rows(1, 2 * PAGE);
    await archive.openArchive(CHANNEL);
    expect(await archive.loadOlder()).toBe(PAGE);
    editAndDelete(1);
    await change();
    expect(shownRow(1)).toMatchObject({ content: 'edited on Discord', deletedAt: 42 });
    expect(shown()).toEqual(rows(1, 2 * PAGE).map((m) => Number(m.id)));
  });

  it('not for an insert-only change, which only appends', async () => {
    env.rows = rows(1, 2 * PAGE);
    await archive.openArchive(CHANNEL);
    editAndDelete(PAGE + 1);
    env.rows = [...env.rows, row(2 * PAGE + 1)];
    await change(true);
    expect(shown().at(-1)).toBe(2 * PAGE + 1);
    expect(shownRow(PAGE + 1)?.content).toBe(`m${PAGE + 1}`);
  });
});

describe('a catch-up past its budget', () => {
  const beyond = CATCH_UP_PAGES * PAGE + 2 * PAGE + 1;

  it.each([false, true])('leaves no gap, and pages on to the newest (insert-only: %s)', async (insertOnly) => {
    env.rows = rows(1, 1);
    await archive.openArchive(CHANNEL);
    env.rows = rows(1, beyond);
    await change(insertOnly);
    expect(unbroken()).toBe(true);
    expect(archive.atNewest()).toBe(false);
    for (let guard = 0; !archive.atNewest() && guard < beyond / PAGE; guard++) await archive.loadNewer();
    expect(archive.atNewest()).toBe(true);
    expect(unbroken()).toBe(true);
    expect(shown().at(-1)).toBe(beyond);
  });
});
