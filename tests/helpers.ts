// The run's temp folder (`inject('tempRoot')`, read by tempDir) is typed in globalSetup.ts.
/// <reference path="./globalSetup.ts" />
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { sleep } from '@shared/async';
import { snowflakeFromMs, type RawGuild, type RawMessage, type RawUser } from '@shared/discord';
import { exeName } from '../src/core/ai/resolveCli';
import { Archive } from '../src/core/archive';
import { installArchiveViews } from '../src/core/archiveViews';
import { openDb, type Db } from '../src/core/db';
import { ARRIVAL, type Arrived } from '../src/core/arrival';
import { MIGRATIONS, applyMigration, type Migration } from '../src/core/migrations';
import { OwnerSession } from '../src/main/discord/ownerSession';

/** Discord's channel type for a guild text channel. */
const GUILD_TEXT_CHANNEL = 0;
/** The guild `seedArchive` stores channels in unless given others. */
const TEST_GUILD: RawGuild = { id: 'g1', name: 'G' };
/** The Toolchain's model folder under its tools directory. */
const MODELS_DIR = 'models';
/** Gateway opcode the client sends to start a session; READY answers it (ownerSession.ts). */
const IDENTIFY_OP = 2;
/** Time for work the app queued on a fake (Jev, an LLM) to finish; the fakes answer at once. */
const ASYNC_SETTLE_MS = 50;

/** A fresh folder inside this run's temp folder (tests/globalSetup.ts), which is removed when the run ends. */
export const tempDir = (): string => mkdtempSync(join(inject('tempRoot'), 'dir-'));

/** A fresh archive database on disk (WAL and VACUUM behave as in the app). */
export const tempDb = (): Db => openDb(join(tempDir(), 'archive.db'));

/** The signed-in Discord user in rule tests. */
export const OWNER: RawUser = { id: 'me', username: 'cujuju', global_name: 'Cujuju' };

let seq = 0;
/** Just after now and increasing, so each message is newer than whatever the test set up before it. */
export const nextTs = (): number => Date.now() + ++seq;

/** A text the gateway delivered just now: live. */
export const arrivedLive = (): Arrived => ({ via: ARRIVAL.gateway, at: Date.now(), edit: false });

/** A message author known only by id. */
export const from = (authorId: string): Partial<RawMessage> => ({ author: { id: authorId, username: authorId } });

export function rawMessage(channelId: string, ms: number, content: string, extra: Partial<RawMessage> = {}): RawMessage {
  return {
    id: snowflakeFromMs(ms),
    channel_id: channelId,
    author: { id: 'u1', username: 'alice', global_name: 'Alice' },
    content,
    timestamp: new Date(ms).toISOString(),
    edited_timestamp: null,
    ...extra,
  };
}

/** A text channel to seed: named by its id and in the first guild unless told otherwise; opted in unless `optIn: false`. */
export interface SeedChannel {
  id: string;
  name?: string;
  guildId?: string;
  optIn?: boolean;
}

/** An Archive over `db` holding `guilds` and `channels`; `onText` sees each new or changed message text. */
export function seedArchive(db: Db, channels: SeedChannel[], o: { guilds?: RawGuild[]; onText?: ConstructorParameters<typeof Archive>[1]; onLinkedText?: ConstructorParameters<typeof Archive>[2] } = {}): Archive {
  const guilds = o.guilds ?? [TEST_GUILD];
  const archive = new Archive(db, o.onText, o.onLinkedText);
  archive.upsertGuilds(guilds);
  for (const c of channels) {
    archive.upsertChannels(c.guildId ?? guilds[0]!.id, [{ id: c.id, name: c.name ?? c.id, type: GUILD_TEXT_CHANNEL }]);
    if (c.optIn !== false) archive.setOptIn(c.id, true);
  }
  return archive;
}

/** The index of the first migration that is `step`, or whose SQL contains it. */
export function migrationIndex(step: string | Migration): number {
  const i = MIGRATIONS.findIndex((m) => m === step || (typeof m === 'string' && typeof step === 'string' && m.includes(step)));
  if (i < 0) throw new Error('No such migration.');
  return i;
}

/** Runs MIGRATIONS[from, to) and records the version. Current-version fixtures install archive views; older frozen fixtures omit them. */
export function applyMigrations(db: Db, from: number, to = MIGRATIONS.length): void {
  db.transaction(() => {
    for (const step of MIGRATIONS.slice(from, to)) applyMigration(db, step);
    db.pragma(`user_version = ${to}`);
    if (to === MIGRATIONS.length) installArchiveViews(db);
  })();
}


/** Waits for work the app queued on a fake (Jev, an LLM) to finish. */
export const settleAsync = (): Promise<void> => sleep(ASYNC_SETTLE_MS);

/** An empty program `id` in `dir/<id>/<sub>`, where the Toolchain finds its own installs (searched recursively). */
export function fakeTool(dir: string, id: string, sub = ''): void {
  mkdirSync(join(dir, id, sub), { recursive: true });
  writeFileSync(join(dir, id, sub, exeName(id)), '');
}

/** An empty model file `id` in the Toolchain's model folder. */
export function fakeModel(dir: string, id: string): void {
  mkdirSync(join(dir, MODELS_DIR), { recursive: true });
  writeFileSync(join(dir, MODELS_DIR, id), '');
}

/** An open Discord page whose isolated world answers each script with `evaluate` (DiscordApi's page). */
export const discordPage = (evaluate: (script: string) => Promise<unknown>) => ({ webContents: { isDestroyed: () => false }, world: { evaluate } });

type HeadersListener = (details: { method: string; url: string; webContentsId?: number; requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void;

/** A Discord session (HeaderCapture's) whose request hook the test drives: `send` is a request the embedded client makes. */
export function fakeDiscordSession(): { session: never; send: (headers: Record<string, string>, url?: string) => Record<string, string> } {
  let listener: HeadersListener | undefined;
  const session = { webRequest: { onBeforeRequest: () => undefined, onBeforeSendHeaders: (_f: unknown, l: HeadersListener) => (listener = l), onCompleted: () => undefined } };
  const send = (headers: Record<string, string>, url = 'https://discord.com/api/v9/users/@me'): Record<string, string> => {
    let passed: Record<string, string> = {};
    listener!({ method: 'GET', url, webContentsId: 1, requestHeaders: headers }, (r) => (passed = r.requestHeaders));
    return passed;
  };
  return { session: session as never, send };
}

/** A captured credential the gateway's IDENTIFY proved: OwnerSession's account is then current. */
const PROVEN_CAPTURE = { current: {}, sessionGeneration: 1, gatewayAuthorized: true, expectGatewayAuthorization: () => undefined, matchesGatewayAuthorization: () => true };
/** The socket gatewayOwner's dispatches arrive on. */
export const OWNER_SOCKET = 'owner-socket';

/**
 * A tap with the OwnerSession main builds on it before every other reader. `dispatch` sends on OWNER_SOCKET and IDENTIFYs
 * it before each READY, as the client does, so READY names the signed-in account.
 */
export function gatewayOwner<E extends EventEmitter>(tap: E = new EventEmitter() as E): { tap: E; owner: OwnerSession; dispatch(t: string, d: unknown, socketId?: string): void } {
  const owner = new OwnerSession(tap as never, PROVEN_CAPTURE as never);
  const dispatch = (t: string, d: unknown, socketId = OWNER_SOCKET): void => {
    if (t === 'READY' && socketId === OWNER_SOCKET) tap.emit('sent', { op: IDENTIFY_OP, d: { token: 'token' }, socketId });
    tap.emit('dispatch', { t, d, s: null, socketId });
  };
  return { tap, owner, dispatch };
}

/** Runs a call as an owner action of `account` (ownerSession.ts), as main's Discord handlers run each call. */
export function ownerAction(account: string): <T>(call: () => Promise<T>) => Promise<T> {
  const tap = new EventEmitter();
  const session = new OwnerSession(tap as never, PROVEN_CAPTURE as never);
  tap.emit('sent', { op: IDENTIFY_OP, d: { token: account }, socketId: account });
  tap.emit('dispatch', { t: 'READY', d: { user: { id: account } }, socketId: account });
  return <T>(call: () => Promise<T>) => session.actions({ call }).call() as Promise<T>;
}
