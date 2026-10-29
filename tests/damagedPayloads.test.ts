// A damaged stored payload (malformed text, or a BLOB that won't decompress) reads as none: no reader throws.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ARRIVAL } from '../src/core/arrival';
import type { Archive } from '../src/core/archive';
import { setSetting, type Db } from '../src/core/db';
import { DERIVE_VERSION_KEY, rederiveIfStale } from '../src/core/derive/rederive';
import { archivePayloads } from '../src/core/plugins/archivePayloads';
import { contentReader } from '../src/core/queries/messageContent';
import { mentionCandidates } from '../src/core/queries/mentions';
import { messagePage, messagesByIds } from '../src/core/queries/messages';
import { savedWritableChannels } from '../src/core/queries/savedWritableChannels';
import { applyReactionEvent } from '../src/core/reactions';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CH = '200000000000000001';
const T0 = Date.UTC(2026, 8, 1);
const DAMAGED: readonly (string | Buffer)[] = ['{"id": "cut off', Buffer.from('not zstd')];

let db: Db;
let archive: Archive;
let ids: string[];

beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: CH }]);
  const messages = [rawMessage(CH, T0, 'kept'), ...DAMAGED.map((_, i) => rawMessage(CH, T0 + i + 1, `damaged ${i}`))];
  archive.ingestMessages(messages, ARRIVAL.gateway);
  ids = messages.map((m) => m.id);
  const damage = db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?');
  DAMAGED.forEach((raw, i) => damage.run(raw, ids[i + 1]));
});

describe('damaged stored payloads', () => {
  it('leave the deletion check working: they are not ephemeral', () => {
    expect(archive.reconcileDeletes(CH, [ids[0]!], ids[0]!, ids.at(-1)!, T0)).toBe(DAMAGED.length);
  });

  it('read as messages without payload details', () => {
    expect(messagePage(db, { channelId: CH, limit: 10 }).map((m) => m.content)).toEqual(['kept', 'damaged 0', 'damaged 1']);
    expect(messagesByIds(db, ids)).toHaveLength(ids.length);
    expect(archivePayloads(db, ids).size).toBe(ids.length);
    expect([...contentReader(db)(ids[1]!)]).toEqual([]);
  });

  it('are replaced by a refetch and skipped by events and the derivation rebuild', () => {
    expect(applyReactionEvent(db, 'MESSAGE_REACTION_ADD', { message_id: ids[1]!, channel_id: CH, user_id: 'u2', emoji: { id: null, name: '👍' } }, null)).toBe(false);
    setSetting(db, DERIVE_VERSION_KEY, 0);
    expect(rederiveIfStale(db, () => undefined)).toBe(ids.length - DAMAGED.length);
    const refetched = rawMessage(CH, T0 + 1, 'damaged 0');
    archive.ingestMessages([refetched], ARRIVAL.sync);
    expect(JSON.parse(db.prepare('SELECT raw_json FROM messages WHERE id = ?').pluck().get(ids[1]) as string)).toEqual(refetched);
  });

  it('of a role read as no role details: names, mentions and saved-message access still read', () => {
    db.prepare("INSERT INTO roles (id, guild_id, name, position, color, raw_json) VALUES ('r1', 'g1', 'Role', 1, 255, ?)").run(DAMAGED[0]);
    db.prepare("INSERT INTO members (guild_id, user_id, roles, updated_at) VALUES ('g1', 'u1', '[\"r1\"]', 0) ON CONFLICT DO UPDATE SET roles = excluded.roles").run();
    expect(messagesByIds(db, [ids[0]!])[0]!.author.name).toBe('Alice');
    expect(mentionCandidates(db, 'u1', CH, 'Role', 10)).toEqual([]);
    expect(() => savedWritableChannels(db, 'u1')).not.toThrow();
  });

  it('are read in SQL only through payloadSql or storedJsonSql, and in code only through parseRawJson', () => {
    const core = join(__dirname, '../src/core');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
    // Where msg_json is registered or the wrappers live.
    const allowed = new Set(['db.ts', 'laterMigrations.ts', join('queries', 'messageContent.ts'), join('queries', 'storedJson.ts'), join('reads', 'archiveReadWorker.ts')]);
    const direct = /msg_json\(|JSON\.parse\(rawJsonText|json_\w+\(\s*(\w+\.)?raw_json\b/;
    expect(files(core).map((f) => relative(core, f)).filter((f) => !allowed.has(f) && direct.test(readFileSync(join(core, f), 'utf8')))).toEqual([]);
  });
});
