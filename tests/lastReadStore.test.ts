import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Accessor } from 'solid-js';
import type { AppEvent, UnreadBoundary, UnreadMark, UnreadSnapshot } from '@shared/contract';
import { SETTINGS_KEYS } from '@shared/settings';
import { ARRIVAL } from '../src/core/arrival';
import { setSetting, type Db } from '../src/core/db';
import { markRead, unreadMark, unreadSnapshot } from '../src/core/queries/readMarks';
import { putReadStates } from '../src/core/queries/readStates';
import { rawMessage, seedArchive, tempDb } from './helpers';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const env = vi.hoisted(() => ({
  channel: (() => null) as Accessor<string | null>,
  archive: { items: [] as { id: string }[] },
  snapshot: vi.fn<(id: string) => Promise<UnreadSnapshot>>(),
  unread: vi.fn<(id: string, since?: string | UnreadBoundary, localReadId?: string) => Promise<UnreadMark | null>>(),
  mark: vi.fn<(id: string, message: string) => Promise<void>>(),
  listeners: new Map<string, Set<(e: AppEvent) => void>>(),
}));
vi.mock('@/api', () => ({ api: { core: { channelUnreadSnapshot: env.snapshot, channelUnread: env.unread, markChannelRead: env.mark } } }));
vi.mock('../src/renderer/src/state/archive', () => ({ archiveChannelId: () => env.channel(), archiveState: env.archive }));
vi.mock('../src/renderer/src/state/events', () => ({
  onAppEvent: (type: string, fn: (e: AppEvent) => void) => {
    const listeners = env.listeners.get(type) ?? new Set();
    listeners.add(fn);
    env.listeners.set(type, listeners);
    return () => listeners.delete(fn);
  },
}));

const solid = await import('solid-js');
const statePath = '../src/renderer/src/state/lastRead';
const state = await import(statePath) as {
  watchArchive(lookable: Accessor<boolean>, seen: Accessor<string | undefined>, companion?: boolean): { acknowledged(): boolean; acknowledge(): void };
  unreadBanner(): UnreadMark | null;
  dismissUnreadBanner(): void;
};
const CH = 'c1';
const BOT = 'bot';
const SELF = 'self';
let db: Db;
let dispose: (() => void) | undefined;
let setChannel: (id: string | null) => void;
let first: string;
let last: string;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
const send = (e: AppEvent): void => env.listeners.get(e.type)?.forEach((fn) => fn(e));
const select = async (ids: string[]): Promise<void> => {
  setSetting(db, SETTINGS_KEYS.countedBots, ids);
  send({ type: 'setting-changed', key: SETTINGS_KEYS.countedBots, value: ids });
  await settle();
};
const watch = (seen: string | Accessor<string | undefined> = last): void => {
  let reading!: ReturnType<typeof state.watchArchive>;
  solid.createRoot((stop) => {
    dispose = stop;
    reading = state.watchArchive(() => true, typeof seen === 'function' ? seen : () => seen);
  });
  // After its first run: the owner acts on the restored channel (a restore holds until an act).
  reading.acknowledge();
};

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  env.listeners.clear();
  env.snapshot.mockReset();
  env.unread.mockReset();
  env.mark.mockReset();
  [env.channel, setChannel] = solid.createSignal<string | null>(CH);
  db = tempDb();
  const archive = seedArchive(db, [{ id: CH }]);
  const at = Date.UTC(2026, 9, 1);
  const a = rawMessage(CH, at, 'bot', { author: { id: BOT, username: BOT, bot: true } });
  const b = rawMessage(CH, at + 1, 'human');
  archive.ingestMessages([a, b], ARRIVAL.gateway);
  first = a.id;
  last = b.id;
  const [items, setItems] = solid.createSignal<{ id: string }[]>([a, b]);
  Object.defineProperty(env.archive, 'items', { configurable: true, get: items, set: setItems });
  env.snapshot.mockImplementation(async (id) => unreadSnapshot(db, id, 0, SELF));
  env.unread.mockImplementation(async (id, since, localReadId) => unreadMark(db, id, 0, SELF, since, localReadId));
  env.mark.mockImplementation(async (id, message) => {
    markRead(db, id, message);
    // Main immediately records the local Discord acknowledgment, then echoes it to every renderer.
    putReadStates(db, [{ channelId: id, ackId: message }], 'merge');
    send({ type: 'read-states-changed', states: [{ channelId: id, ackId: message }] });
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  db.close();
  vi.unstubAllGlobals();
});

describe('opening banner changes with bot selection', () => {
  it('includes an earlier excluded bot after local marking, and keeps the opening boundary when it is disabled again', async () => {
    watch();
    await settle();
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: last });
    expect(env.mark).toHaveBeenCalledWith(CH, last);
    expect(unreadMark(db, CH, 0, SELF)).toBeNull();
    await select([BOT]);
    expect(state.unreadBanner()).toMatchObject({ count: 2, firstId: first });
    await select([]);
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: last });
    await select([BOT]);
    expect(state.unreadBanner()).toMatchObject({ count: 2, firstId: first });
  });

  it('can show a bot-only opening that was empty before selection, even after its local read mark advanced', async () => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(last);
    last = first;
    env.archive.items = [{ id: first }];
    watch();
    await settle();
    expect(state.unreadBanner()).toBeNull();
    expect(env.mark).toHaveBeenCalledWith(CH, first);
    await select([BOT]);
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: first });
  });

  it('never resurrects a dismissed banner, including a policy response already in flight', async () => {
    watch();
    await settle();
    let answer!: (mark: UnreadMark | null) => void;
    env.unread.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await select([BOT]);
    state.dismissUnreadBanner();
    answer({ channelId: CH, count: 2, firstId: first, firstTs: 1 });
    await settle();
    expect(state.unreadBanner()).toBeNull();
    const calls = env.unread.mock.calls.length;
    await select([]);
    await select([BOT]);
    expect(env.unread).toHaveBeenCalledTimes(calls);
    expect(state.unreadBanner()).toBeNull();
  });

  it('ignores older preference responses and a response for a channel that was put away', async () => {
    watch();
    await settle();
    const answers: ((mark: UnreadMark | null) => void)[] = [];
    env.unread.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    await select([BOT]);
    await select([]);
    answers[1]!({ channelId: CH, count: 1, firstId: last, firstTs: 2 });
    answers[0]!({ channelId: CH, count: 2, firstId: first, firstTs: 1 });
    await settle();
    expect(state.unreadBanner()?.count).toBe(1);
    await select([BOT]);
    setChannel(null);
    answers[2]!({ channelId: CH, count: 2, firstId: first, firstTs: 1 });
    await settle();
    expect(state.unreadBanner()).toBeNull();
  });

  it('still clears messages acknowledged externally and ignores unrelated settings', async () => {
    watch();
    await settle();
    await select([BOT]);
    // An acknowledgment beyond this view’s own mark is an external read.
    const ackId = (BigInt(last) + 1n).toString();
    putReadStates(db, [{ channelId: CH, ackId }], 'merge');
    send({ type: 'read-states-changed', states: [{ channelId: CH, ackId }] });
    await settle();
    expect(state.unreadBanner()).toBeNull();
    const calls = env.unread.mock.calls.length;
    send({ type: 'setting-changed', key: SETTINGS_KEYS.appearance, value: {} });
    await settle();
    expect(env.unread).toHaveBeenCalledTimes(calls);
  });

  it('never forgets an external read after local visibility catches up and the bot selection changes', async () => {
    const [seen, setSeen] = solid.createSignal<string | undefined>(first);
    watch(seen);
    await settle();
    expect(state.unreadBanner()?.count).toBe(1);
    putReadStates(db, [{ channelId: CH, ackId: last }], 'merge');
    send({ type: 'read-states-changed', states: [{ channelId: CH, ackId: last }] });
    await settle();
    expect(state.unreadBanner()).toBeNull();
    setSeen(last);
    await settle();
    expect(env.mark).toHaveBeenLastCalledWith(CH, last);
    await select([BOT]);
    expect(state.unreadBanner()).toBeNull();
    await select([]);
    expect(state.unreadBanner()).toBeNull();
  });
});

describe('away and back', () => {
  // Minimizing and restoring flip page visibility and window focus in separate steps, in either order.
  it.each([['visible first', true], ['focus first', false]])('banners what came while away, restoring %s', async (_, visibleFirst) => {
    const [visible, setVisible] = solid.createSignal(true);
    const [focused, setFocused] = solid.createSignal(true);
    const [items, setItems] = solid.createSignal(env.archive.items);
    solid.createRoot((stop) => {
      dispose = stop;
      state.watchArchive(() => visible() && focused(), () => items().at(-1)?.id, true);
    });
    await settle();
    state.dismissUnreadBanner();
    expect(env.mark).toHaveBeenLastCalledWith(CH, last);
    setFocused(false);
    setVisible(false);
    const later = rawMessage(CH, Date.UTC(2026, 9, 1) + 2, 'while away');
    seedArchive(db, []).ingestMessages([later], ARRIVAL.gateway);
    env.archive.items = [...env.archive.items, later];
    setItems(env.archive.items);
    await settle();
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
    if (visibleFirst) setVisible(true); else setFocused(true);
    await settle();
    if (visibleFirst) setFocused(true); else setVisible(true);
    await settle();
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: later.id });
    expect(env.mark).toHaveBeenLastCalledWith(CH, later.id);
  });
});

describe('desktop acknowledgement', () => {
  /** Mounts the desktop view and acknowledges what the restore showed, as a scroll would. */
  const watchDesktop = async (looking: Accessor<boolean>): Promise<ReturnType<typeof state.watchArchive>> => {
    let reading!: ReturnType<typeof state.watchArchive>;
    solid.createRoot((stop) => {
      dispose = stop;
      reading = state.watchArchive(looking, () => env.archive.items.at(-1)?.id);
    });
    reading.acknowledge();
    await settle();
    return reading;
  };
  const store = (offset: number) => {
    const later = rawMessage(CH, Date.UTC(2026, 9, 1) + offset, 'away');
    seedArchive(db, []).ingestMessages([later], ARRIVAL.gateway);
    return later;
  };

  it('holds a restored channel with unread until an act', async () => {
    solid.createRoot((stop) => {
      dispose = stop;
      const reading = state.watchArchive(() => true, () => env.archive.items.at(-1)?.id);
      void settle().then(() => {
        expect(reading.acknowledged()).toBe(false);
        expect(env.mark).not.toHaveBeenCalled();
        reading.acknowledge();
      });
    });
    await settle();
    await settle();
    expect(env.mark).toHaveBeenLastCalledWith(CH, last);
  });

  it('holds rows that load only after the return (hidden views defer loading)', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    state.dismissUnreadBanner();
    setLooking(false);
    const later = store(2);
    await settle();
    setLooking(true);
    await settle();
    env.archive.items = [...env.archive.items, later];
    await settle();
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: later.id });
  });

  it('keeps counting arrivals while focused under a hold', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    await watchDesktop(looking);
    state.dismissUnreadBanner();
    setLooking(false);
    const a = store(2);
    env.archive.items = [...env.archive.items, a];
    await settle();
    setLooking(true);
    await settle();
    const b = store(3);
    env.archive.items = [...env.archive.items, b];
    await settle();
    expect(state.unreadBanner()).toMatchObject({ count: 2, firstId: a.id });
    expect(env.mark).not.toHaveBeenCalledWith(CH, b.id);
  });

  it('counts arrivals live while unfocused and holds marks and banner through focus and content clicks', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    state.dismissUnreadBanner();
    setLooking(false);
    const arrive = async (offset: number) => {
      const later = rawMessage(CH, Date.UTC(2026, 9, 1) + offset, 'away');
      seedArchive(db, []).ingestMessages([later], ARRIVAL.gateway);
      env.archive.items = [...env.archive.items, later];
      await settle();
      return later.id;
    };
    const firstAway = await arrive(2);
    expect(state.unreadBanner()).toMatchObject({ count: 1, firstId: firstAway });
    const newest = await arrive(3);
    expect(state.unreadBanner()).toMatchObject({ count: 2, firstId: firstAway });
    setLooking(true);
    await settle();
    expect(reading.acknowledged()).toBe(false);
    const target = (globalThis as unknown as { window: EventTarget }).window;
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('mouseover'));
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, newest);
    reading.acknowledge();
    await settle();
    expect(reading.acknowledged()).toBe(true);
    expect(env.mark).toHaveBeenLastCalledWith(CH, newest);
  });

  it('releases a return without arrivals and continues live marking', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    setLooking(false);
    expect(reading.acknowledged()).toBe(false);
    setLooking(true);
    await settle();
    expect(reading.acknowledged()).toBe(true);
    const later = rawMessage(CH, Date.UTC(2026, 9, 1) + 2, 'active');
    env.archive.items = [...env.archive.items, later];
    await settle();
    expect(env.mark).toHaveBeenLastCalledWith(CH, later.id);
  });

  it('an act made while away does not carry past the return', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    setLooking(false);
    const later = store(2);
    env.archive.items = [...env.archive.items, later];
    await settle();
    reading.acknowledge();
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
    setLooking(true);
    await settle();
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
  });

  it('holds rows stored after an act while away that load only after the return', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    setLooking(false);
    reading.acknowledge();
    await settle();
    const later = store(2);
    setLooking(true);
    await settle();
    env.archive.items = [...env.archive.items, later];
    await settle();
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
  });

  it('ignores a storage check answered after a newer away and return', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    state.dismissUnreadBanner();
    let stale!: (mark: UnreadMark | null) => void;
    env.unread.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }));
    setLooking(false);
    setLooking(true);
    setLooking(false);
    const later = store(2);
    setLooking(true);
    await settle();
    stale(null);
    await settle();
    env.archive.items = [...env.archive.items, later];
    await settle();
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, later.id);
  });

  it('holds an arrival after an acknowledgement made while away', async () => {
    const [looking, setLooking] = solid.createSignal(true);
    const reading = await watchDesktop(looking);
    setLooking(false);
    const arrive = async (offset: number) => {
      const later = rawMessage(CH, Date.UTC(2026, 9, 1) + offset, 'away');
      seedArchive(db, []).ingestMessages([later], ARRIVAL.gateway);
      env.archive.items = [...env.archive.items, later];
      await settle();
      return later.id;
    };
    await arrive(2);
    reading.acknowledge();
    const after = await arrive(3);
    setLooking(true);
    await settle();
    expect(reading.acknowledged()).toBe(false);
    expect(env.mark).not.toHaveBeenCalledWith(CH, after);
  });
});
