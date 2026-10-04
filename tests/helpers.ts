// The run's temp folder (`inject('tempRoot')`, read by tempDir) is typed in globalSetup.ts.
/// <reference path="./globalSetup.ts" />
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

/** Discord's channel type for a guild text channel. */
const GUILD_TEXT_CHANNEL = 0;
/** The guild `seedArchive` stores channels in unless given others. */
const TEST_GUILD: RawGuild = { id: 'g1', name: 'G' };
/** The Toolchain's model folder under its tools directory. */
const MODELS_DIR = 'models';
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

/**
 * Runs MIGRATIONS[from, to) on `db` and records the version. Reaching the current version installs the archive views, as
 * openDb does after an upgrade; an older version (a frozen fixture) has none.
 */
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
