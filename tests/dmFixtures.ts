// DM-write harness: real temporary archive and core signed in as SELF, with a fake DiscordWriter. Tests mock Electron paths.
import type { RawPrivateChannel } from '@shared/discord';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE } from '@shared/discord';
import type { CoreMethod } from '@shared/contract';
import type { Archive } from '../src/core/archive';
import { archiveHandlers } from '../src/core/archiveHandlers';
import type { Db } from '../src/core/db';
import { DmService } from '../src/main/discord/dms';
import { seedArchive, tempDb } from './helpers';

export const SELF = '900000000000000001';
export const BOB = { id: '110000000000000001', username: 'bob', global_name: 'Bob', avatar: 'b0b' };
export const CY = { id: '110000000000000002', username: 'cy' };
export const DI = { id: '110000000000000003', username: 'di' };
export const STRANGER = '110000000000000009';
export const DM = '400000000000000001';
export const GROUP = '400000000000000002';
export const NEW = '400000000000000003';
export const GUILD_CHANNEL = '200000000000000001';
const FRIEND_USERS = [BOB, CY, DI];
export const friends = {
  isFriend: (id: string): boolean => FRIEND_USERS.some((u) => u.id === id),
  user: (id: string) => FRIEND_USERS.find((u) => u.id === id),
};
/** Snowflake-shaped user ids, `n` of them, for the cap. */
export const people = (n: number): string[] => Array.from({ length: n }, (_, i) => String(120000000000000000n + BigInt(i)));

export const dm: RawPrivateChannel = { id: DM, type: DM_CHANNEL_TYPE, recipients: [BOB] };
export const group: RawPrivateChannel = { id: GROUP, type: GROUP_DM_CHANNEL_TYPE, name: 'crew', owner_id: SELF, recipients: [CY, DI] };

/** Creates server, DM, and group channels with core handlers. signIn changes the account in both core and main. */
export function dmArchive(o: { autoArchiveSinceMs?: number } = {}) {
  let self: string | null = SELF;
  const db: Db = tempDb();
  const a: Archive = seedArchive(db, [{ id: GUILD_CHANNEL }]);
  a.replacePrivateChannels(SELF, [dm, group], false, Date.now());
  const events: unknown[] = [];
  const handlers = {
    ...archiveHandlers({
      ready: () => ({ db, archive: a }),
      emit: (e) => void events.push(e),
      noteChanged: () => undefined,
      backfillFromMs: () => 0,
      selfId: () => self,
      lastSeenAt: () => 0,
      applyTextTier: async () => undefined,
      autoArchiveSinceMs: () => o.autoArchiveSinceMs ?? null,
    }),
    selfId: () => self,
  };
  const call = async (method: CoreMethod, ...params: unknown[]): Promise<unknown> =>
    (handlers as unknown as Record<string, (...p: unknown[]) => unknown>)[method]!(...params);
  const row = (id: string) =>
    db.prepare('SELECT name, kind, account_id, last_message_id, closed_at, owner_id, peer_id, recipients, opted_in, auto_declined FROM channels WHERE id = ?').get(id);
  const signIn = (id: string | null): void => {
    self = id;
  };
  return { db, a, call, events, row, signIn, account: () => self };
}

export interface Write {
  method: string;
  path: string;
  body?: unknown;
  opts?: unknown;
}

/** Records writes and returns configured answers. Runs guards after the queue wait; thrown guards prevent sending. */
export function writer(answer: (method: string, path: string) => unknown = () => undefined, queued: () => void = () => undefined) {
  const writes: Write[] = [];
  const run = (method: string, path: string, body?: unknown, options?: { guard?: () => void }): Promise<unknown> => {
    try {
      queued();
      options?.guard?.();
      const { guard: _guard, ...opts } = options ?? {};
      writes.push({ method, path, ...(body !== undefined ? { body } : {}), ...(Object.keys(opts).length ? { opts } : {}) });
      return Promise.resolve(answer(method, path));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  type Opts = { guard?: () => void };
  const api = {
    post: (p: string, b: unknown, o?: Opts) => run('POST', p, b, o),
    postOnce: (p: string, b: unknown, o?: Opts) => run('POST once', p, b, o),
    put: (p: string, o?: Opts) => run('PUT', p, undefined, o),
    patch: (p: string, b: unknown, o?: Opts) => run('PATCH', p, b, o),
    delete: (p: string, o?: Opts) => run('DELETE', p, undefined, o),
    upload: async () => undefined,
  };
  return { api: api as never, writes };
}

/** The DM service over `core`, signed in as `core`'s account, answering writes from `answer`; records notes and settings answers. */
export function dmService(
  core: Pick<ReturnType<typeof dmArchive>, 'call' | 'account'>,
  answer?: (method: string, path: string) => unknown,
  now?: () => number,
  queued?: () => void,
) {
  const w = writer(answer, queued);
  const notes: [string, Record<string, unknown>][] = [];
  const settings: unknown[] = [];
  const dms = new DmService({
    api: w.api,
    core: { call: core.call } as never,
    account: core.account,
    friends,
    settingsChanged: (s) => void settings.push(s),
    diag: (e, d) => void notes.push([e, d]),
    ...(now ? { now } : {}),
  });
  return { dms, writes: w.writes, notes, settings };
}
