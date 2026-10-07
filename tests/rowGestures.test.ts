// A message row's gestures follow this device's chat settings: the swipe runs swipeAction, the double tap adds doubleTapEmoji.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_CHAT_SETTINGS, type DeviceChatSettings } from '@shared/chatSettings';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import { setPostingUnlocked } from './postingSwitch';

// Uses Solid's browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  settings: null as unknown as DeviceChatSettings,
  reacts: [] as { messageId: string; emoji: ArchiveEmoji; add: boolean }[],
  gestures: {} as Record<'swipe' | 'doubleTap', { run(): void; enabled(): boolean }>,
}));
vi.mock('virtual:bundled-plugins/shared', async () => (await import('./postingSwitch')).bundledPluginsModule);
vi.mock('../src/renderer/src/state/plugins', async () => (await import('./postingSwitch')).pluginsModule);
vi.mock('../src/renderer/src/state/chatSettings', () => ({ deviceChatSettings: () => env.settings }));
vi.mock('@/api', () => ({
  api: { discord: { react: async (r: (typeof env.reacts)[number]) => void env.reacts.push(r) }, core: { ownReactions: async () => [] } },
}));
vi.mock('../src/renderer/src/state/archive', () => ({ archiveChannelId: () => CHANNEL, openArchive: async () => undefined, refreshLoaded: async () => undefined }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('../src/renderer/src/state/ui', () => ({ inPanelWindow: false }));
// The DOM recognizers are covered by taps.test.ts: here each gesture's run and gate are captured.
vi.mock('../src/renderer/src/ui/touch', () => ({
  swipeLeftToAct: (run: () => void, enabled: () => boolean) => void (env.gestures.swipe = { run, enabled }),
  doubleTapToAct: (run: () => void, enabled: () => boolean) => void (env.gestures.doubleTap = { run, enabled }),
  allTouch: () => ({}),
}));

// Renderer modules: imported by path so the node type-check doesn't follow them.
const rowGesturesPath = '../src/renderer/src/panels/chat/rowGestures';
const replyPath = '../src/renderer/src/state/reply';
const { rowGestures } = (await import(rowGesturesPath)) as { rowGestures(m: () => ArchiveMessage): unknown };
const reply = (await import(replyPath)) as { replyTarget(): ArchiveMessage | null; cancelReply(): void };

const CHANNEL = '300000000000000001';
const HEART: ArchiveEmoji = { id: null, name: '❤️', animated: false };
const FIRE: ArchiveEmoji = { id: null, name: '🔥', animated: false };
const message = (extra: Partial<ArchiveMessage> = {}): ArchiveMessage =>
  ({ id: '500000000000000001', channelId: CHANNEL, deletedAt: null, reactions: [], ...extra }) as unknown as ArchiveMessage;
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

let m: ArchiveMessage;
beforeEach(() => {
  env.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS };
  env.reacts = [];
  m = message();
  reply.cancelReply();
  setPostingUnlocked(true);
  rowGestures(() => m);
});

describe('the right-to-left swipe', () => {
  it('replies when set to reply, while posting is unlocked and the message takes replies', () => {
    expect(env.gestures.swipe.enabled()).toBe(true);
    env.gestures.swipe.run();
    expect(reply.replyTarget()).toBe(m);
    setPostingUnlocked(false);
    expect(env.gestures.swipe.enabled()).toBe(false);
    setPostingUnlocked(true);
    m = message({ deletedAt: 1 });
    expect(env.gestures.swipe.enabled()).toBe(false);
  });

  it('never arms when set to none', () => {
    env.settings = { ...env.settings, swipeAction: 'none' };
    expect(env.gestures.swipe.enabled()).toBe(false);
  });

  it('follows a settings change on the next touch', () => {
    expect(env.gestures.swipe.enabled()).toBe(true);
    env.settings = { ...env.settings, swipeAction: 'none' };
    expect(env.gestures.swipe.enabled()).toBe(false);
  });
});

describe('the double tap', () => {
  it('adds the chosen emoji', async () => {
    env.settings = { ...env.settings, doubleTapEmoji: FIRE };
    expect(env.gestures.doubleTap.enabled()).toBe(true);
    env.gestures.doubleTap.run();
    await settled();
    expect(env.reacts).toEqual([{ channelId: CHANNEL, messageId: m.id, emoji: FIRE, add: true }]);
  });

  it('only adds: a reaction the owner already has stays', async () => {
    m = message({ reactions: [{ emoji: HEART, count: 1, me: true }] as ArchiveMessage['reactions'] });
    env.gestures.doubleTap.run();
    await settled();
    expect(env.reacts).toEqual([]);
  });

  it('is off when the setting is off, or on a deleted message', () => {
    env.settings = { ...env.settings, doubleTapReact: false };
    expect(env.gestures.doubleTap.enabled()).toBe(false);
    env.settings = { ...env.settings, doubleTapReact: true };
    m = message({ deletedAt: 1 });
    expect(env.gestures.doubleTap.enabled()).toBe(false);
  });

  it('works while posting is locked, as other reactions do', () => {
    setPostingUnlocked(false);
    expect(env.gestures.doubleTap.enabled()).toBe(true);
  });
});
