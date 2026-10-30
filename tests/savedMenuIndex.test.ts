// A message menu offers Bookmark and Remind without the Bookmarks panel shown (the phone shows one tab at a time):
// the saved-message index is read whenever posting is on, and again after each reset.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { SavedIndex } from '@shared/savedMessages';

// Uses Solid's browser runtime so effects run as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

const CHANNEL = '100000000000000001';
const MESSAGE = '200000000000000002';
const listeners = new Map<string, (e: unknown) => void>();
const [unlocked, setUnlocked] = createSignal(false);
const index = (session: string, revision: number): SavedIndex => ({ session, revision, pageEpoch: 0, writableChannelIds: [CHANNEL], reminders: [], bookmarkIds: [] });
let current = index('S1', 1);
const savedMessages = vi.fn(async () => current);
const savedBookmarks = vi.fn();

vi.mock('@/api', () => ({ api: { discord: { savedMessages, savedBookmarks }, core: {} } }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: (type: string, fn: (e: unknown) => void) => { listeners.set(type, fn); return () => undefined; } }));
vi.mock('../src/renderer/src/state/posting', () => ({ postingUnlocked: () => unlocked(), closeWhenLocked: () => undefined }));
vi.mock('../src/renderer/src/state/ui', () => ({ contextMenu: () => null, setContextMenu: () => undefined }));
vi.mock('../src/renderer/src/state/layout', () => ({ openPanel: () => undefined }));
vi.mock('../src/renderer/src/state/archive', () => ({ openArchiveAt: async () => undefined }));
vi.mock('../src/renderer/src/state/clock', () => ({ now: () => 0 }));
vi.mock('../src/renderer/src/state/unreadCounts', () => ({ unreadCounts: { host: () => undefined } }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined, isThread: () => false }));
vi.mock('../src/renderer/src/state/dialogs', () => ({ failureNotice: () => () => undefined }));
vi.mock('@plugin-sdk/renderer/settings', () => ({ createSetting: <T>(_key: string, fallback: T) => [() => fallback, () => undefined] }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const savedPath = '../src/renderer/src/state/savedMessages';
const saved = (await import(savedPath)) as { savedMenuItems(target: { channelId: string; messageId: string; summary: string }): { submenu?: { items: { label: string }[] }[] }[] };

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
/** The labels in the menu's Bookmarks and reminders submenu. */
const offered = (): string[] => saved.savedMenuItems({ channelId: CHANNEL, messageId: MESSAGE, summary: 'hi' })[0]!.submenu!.flatMap((g) => g.items.map((i) => i.label));
const ACTIONS = ['Bookmark', 'Remind me…'];

describe('the message menu’s saved actions', () => {
  it('are offered once posting is on, with no panel mounted, and again after each reset', async () => {
    await settle();
    expect(savedMessages).not.toHaveBeenCalled();
    expect(offered()).not.toEqual(expect.arrayContaining(ACTIONS));

    setUnlocked(true);
    await settle();
    expect(savedMessages).toHaveBeenCalledTimes(1);
    // Index only: bookmark pages are the panel's.
    expect(savedBookmarks).not.toHaveBeenCalled();
    expect(offered()).toEqual(expect.arrayContaining(ACTIONS));

    // Another account bound: the store resets and reads the new index.
    current = index('S2', 2);
    listeners.get('saved-messages-changed')!({ session: 'S2', revision: 2, pageEpoch: 0, reset: true });
    await settle();
    expect(savedMessages).toHaveBeenCalledTimes(2);
    expect(offered()).toEqual(expect.arrayContaining(ACTIONS));

    listeners.get('privacy-changed')!({});
    await settle();
    expect(savedMessages).toHaveBeenCalledTimes(3);
    expect(offered()).toEqual(expect.arrayContaining(ACTIONS));
  });
});
