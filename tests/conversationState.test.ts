import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, ArchiveMessage, ConversationView } from '@shared/contract';
import { ARCHIVE_REFRESH_DEBOUNCE_MS } from '@shared/archiveRefresh';
import { postedArchiveMessage } from '@shared/postedMessage';
import { acceptedMessage } from './postedMessageFixture';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createRoot, mapArray, onCleanup } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
const env = vi.hoisted(() => ({
  emit: (_event: AppEvent): void => undefined,
  read: vi.fn<(id: string, options: { nearby: boolean }) => Promise<ConversationView>>(),
  view: undefined as ConversationView | undefined,
}));
vi.mock('@/api', () => ({ api: {
  core: { conversation: env.read },
  onEvent: (fn: (event: AppEvent) => void) => { env.emit = fn; return () => undefined; },
} }));

// Variable paths keep renderer imports out of the node type-check.
const statePath = '../src/renderer/src/state/conversation';
const state = await import(statePath) as {
  conversation: { (): ConversationView | undefined; readonly loading: boolean; refetch(): Promise<void> };
  openConversation(id: string): void;
  closeConversation(): void;
};
const rowsPath = '../src/renderer/src/ui/keyedRows';
const { keyedRows } = await import(rowsPath) as {
  keyedRows<T extends { id: string }>(list: () => readonly T[]): { ids(): string[]; item(id: string): T | undefined };
};

const ROOT_CHANNEL = 'root-channel';
const THREAD_CHANNEL = 'thread-channel';
const ROOT = 'root-message';
const THREAD = 'thread-message';
const ROW_KINDS = ['messages', 'edits', 'deletes', 'reactions', 'polls', 'attachments', 'links', 'names', 'plugin'] as const;
const base = postedArchiveMessage(acceptedMessage({ channelId: ROOT_CHANNEL, text: 'before', nonce: '0', files: [], replyTo: null, stickerId: null, gif: null }).message, '0');
const message = (id: string, channelId: string): ArchiveMessage => ({ ...base, id, channelId });
const view = (): ConversationView => ({
  messages: [message(ROOT, ROOT_CHANNEL), message(THREAD, THREAD_CHANNEL)],
  linkedIds: [ROOT], pending: false, rootId: ROOT, marks: {}, memberCount: 2, unlinkedMore: false,
  members: Object.fromEntries([ROOT, THREAD].map((id) => [id, { kind: 'reply', confidence: 1, explicit: true, questionable: false, branch: 0 }])),
});
const shown = (id = THREAD): ArchiveMessage | undefined => state.conversation()?.messages.find((m) => m.id === id);
const change = (channelId: string, kind: typeof ROW_KINDS[number]): void =>
  env.emit({ type: 'archive-changed', changes: { [channelId]: [kind] }, insertOnlyChannelIds: [] });
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(ARCHIVE_REFRESH_DEBOUNCE_MS); };

beforeEach(async () => {
  vi.useFakeTimers();
  env.view = view();
  env.read.mockReset().mockImplementation(async () => structuredClone(env.view!));
  state.openConversation(ROOT);
  await vi.advanceTimersByTimeAsync(0);
  env.read.mockClear();
});
afterEach(async () => {
  state.closeConversation();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe('conversation snapshot updates', () => {
  it.each(ROW_KINDS)('refreshes %s in every displayed channel', async (kind) => {
    for (const channelId of [ROOT_CHANNEL, THREAD_CHANNEL]) {
      env.view!.messages = env.view!.messages.map((m) => ({ ...m, content: `${kind} in ${channelId}` }));
      change(channelId, kind);
      await flush();
      expect(shown()?.content).toBe(`${kind} in ${channelId}`);
    }
    expect(env.read).toHaveBeenCalledTimes(2);
  });

  it('refreshes reaction counts and the owner flag for adding and removing', async () => {
    const emoji = { id: null, name: '👍', animated: false };
    for (const me of [true, false]) {
      env.view!.messages[1] = { ...env.view!.messages[1]!, reactions: [{ emoji, me, count: me ? 2 : 1 }] };
      change(THREAD_CHANNEL, 'reactions');
      await flush();
      expect(shown()?.reactions).toEqual([{ emoji, me, count: me ? 2 : 1 }]);
    }
  });

  it.each(['message-labels-changed', 'attachment-notes-changed'] as const)('refreshes %s for displayed messages only', async (type) => {
    env.view!.messages[1] = { ...env.view!.messages[1]!, content: 'parts changed' };
    env.emit({ type, messageIds: ['unshown'] });
    await flush();
    expect(env.read).not.toHaveBeenCalled();
    env.emit({ type, messageIds: [THREAD] });
    await flush();
    expect(shown()?.content).toBe('parts changed');
  });

  it('refreshes plugin toggles and global name changes', async () => {
    env.emit({ type: 'plugins-changed' });
    await flush();
    expect(env.read).toHaveBeenCalledTimes(1);
    change('', 'names');
    await flush();
    expect(env.read).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated channels and an unsupported change kind', async () => {
    change('unshown-channel', 'reactions');
    env.emit({ type: 'archive-changed', changes: { [ROOT_CHANNEL]: ['disk'] }, insertOnlyChannelIds: [] });
    await flush();
    expect(env.read).not.toHaveBeenCalled();
  });

  it('stops refreshing a channel after its last displayed message leaves', async () => {
    env.view!.messages = [message(ROOT, ROOT_CHANNEL)];
    env.emit({ type: 'conversations-changed', channelIds: [THREAD_CHANNEL] });
    await flush();
    expect(state.conversation()?.messages).toHaveLength(1);
    env.read.mockClear();
    change(THREAD_CHANNEL, 'edits');
    await flush();
    expect(env.read).not.toHaveBeenCalled();
  });

  it('does not fetch archive or message-part updates while closed', async () => {
    state.closeConversation();
    change(THREAD_CHANNEL, 'reactions');
    env.emit({ type: 'message-labels-changed', messageIds: [THREAD] });
    env.emit({ type: 'plugins-changed' });
    await flush();
    expect(env.read).not.toHaveBeenCalled();
    expect(state.conversation()).toBeUndefined();
  });

  it('waits for an older read before refreshing a displayed channel', async () => {
    let answer!: (value: ConversationView) => void;
    env.read.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    state.conversation.refetch();
    await vi.advanceTimersByTimeAsync(0);
    const old = structuredClone(env.view!);
    env.view!.messages[1] = { ...env.view!.messages[1]!, content: 'newer snapshot' };
    change(THREAD_CHANNEL, 'edits');
    await flush();
    expect(env.read).toHaveBeenCalledTimes(1);
    answer(old);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.read).toHaveBeenCalledTimes(2);
    expect(shown()?.content).toBe('newer snapshot');
  });

  it.each(['archive', 'parts', 'mixed'] as const)('coalesces spaced %s events during a slow read into one rerun', async (kind) => {
    const answers: ((value: ConversationView) => void)[] = [];
    let active = 0;
    let maximumActive = 0;
    env.read.mockImplementation(() => new Promise<ConversationView>((resolve) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      answers.push(resolve);
    }).finally(() => { active--; }));
    const events = [
      () => change(THREAD_CHANNEL, 'reactions'),
      () => env.emit({ type: 'message-labels-changed', messageIds: [THREAD] }),
      () => env.emit({ type: 'attachment-notes-changed', messageIds: [THREAD] }),
      () => env.emit({ type: 'plugins-changed' }),
    ];
    const EVENT_COUNT = 6;
    for (let i = 0; i < EVENT_COUNT; i++) {
      const event = kind === 'archive' ? events[0]! : kind === 'parts' ? events[1]! : events[i % events.length]!;
      event();
      await flush();
      expect(env.read).toHaveBeenCalledTimes(1);
      expect(active).toBe(1);
    }
    answers[0]!(structuredClone(env.view!));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.read).toHaveBeenCalledTimes(2);
    expect(active).toBe(1);
    answers[1]!(structuredClone(env.view!));
    await flush();
    expect(env.read).toHaveBeenCalledTimes(2);
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
  });

  it('batches archive and message-part bursts together before reading', async () => {
    change(THREAD_CHANNEL, 'reactions');
    env.emit({ type: 'message-labels-changed', messageIds: [THREAD] });
    env.emit({ type: 'attachment-notes-changed', messageIds: [THREAD] });
    expect(env.read).not.toHaveBeenCalled();
    await flush();
    expect(env.read).toHaveBeenCalledTimes(1);
  });
});

describe('conversation row identity', () => {
  it('keeps mounted rows across fresh snapshots and reordering, with reactive message lookups', async () => {
    const mounted: string[] = [];
    const disposed: string[] = [];
    const root = createRoot((dispose) => {
      const rows = keyedRows(() => state.conversation()?.messages ?? []);
      const mapped = mapArray(rows.ids, (id) => {
        mounted.push(id);
        onCleanup(() => disposed.push(id));
        return { id, message: () => rows.item(id) };
      });
      return { dispose, mapped };
    });
    try {
      const before = [...root.mapped()];
      env.view!.messages = [...env.view!.messages].reverse().map((m) => ({ ...m, content: 'fresh' }));
      env.emit({ type: 'conversations-changed', channelIds: [THREAD_CHANNEL] });
      await flush();
      const after = root.mapped();
      expect(after[0]).toBe(before[1]);
      expect(after[1]).toBe(before[0]);
      expect(after[0]!.message()?.content).toBe('fresh');
      expect(mounted).toEqual([ROOT, THREAD]);
      expect(disposed).toEqual([]);
      env.view!.messages = [message(ROOT, ROOT_CHANNEL)];
      env.emit({ type: 'conversations-changed', channelIds: [ROOT_CHANNEL] });
      await flush();
      expect(root.mapped()[0]).toBe(before[0]);
      expect(disposed).toEqual([THREAD]);
    } finally {
      root.dispose();
    }
  });
});
