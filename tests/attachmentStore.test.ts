import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { snowflakeFromMs } from '@shared/discord';
import { BYTES_PER_GB } from '@shared/units';
import { FREE_ATTACHMENTS_MAX, type ReplaceStored } from '@shared/contract';
import { attachmentStoreHandlers } from '../src/core/attachmentStoreHandlers';
import { freeAttachments, replaceStoredFile, storedFileOf } from '../src/core/attachmentStore';
import { enforceAttachmentCap, skipPrunedPending, storedAttachmentPath } from '../src/core/attachmentRetention';
import { getSetting, migrate, setSetting, type Db } from '../src/core/db';
import { deriveMessage } from '../src/core/derive/deriveMessage';
import { attachmentStored } from '../src/core/mediaQueue';
import { applyMigration, MIGRATIONS } from '../src/core/migrations';
import { messagesByIds } from '../src/core/queries/messages';
import { PHONE_CORE_METHODS } from '@shared/phone';
import { RENDERER_CORE_METHODS } from '@shared/rendererApi';
import { rawMessage, seedArchive, tempDb, tempDir } from './helpers';

const TS = Date.parse('2026-01-01T00:00:00Z');
const OLD_BYTES = 20;
const NEW_BYTES = 8;
const OLD_SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);
const FRONTIER = 'archive.attachmentsPrunedBefore';
const IDS = [snowflakeFromMs(TS, 1), snowflakeFromMs(TS, 2)];
const REPLACEMENT: ReplaceStored = { sha256: OLD_SHA, newSha256: NEW_SHA, storedExt: 'webp', bytes: NEW_BYTES };
let db: Db;
let dir: string;
let messageIds: string[];

const file = (sha256 = OLD_SHA, storedExt: string | null = null) => ({ sha256, filename: 'picture.png', storedExt });
function put(sha256: string, bytes: number, storedExt: string | null = null): string {
  const path = storedAttachmentPath(dir, file(sha256, storedExt));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

beforeEach(() => {
  db = tempDb();
  dir = tempDir();
  const archive = seedArchive(db, [{ id: 'c1' }, { id: 'c2' }]);
  put(OLD_SHA, OLD_BYTES);
  messageIds = IDS.map((id, i) => {
    const m = rawMessage(`c${i + 1}`, TS + i, '', { attachments: [{ id, filename: 'picture.png', content_type: 'image/png', url: 'https://cdn.example/picture.png' }] });
    archive.ingestMessages([m], 'gateway');
    attachmentStored(db, dir, id, OLD_SHA, OLD_BYTES);
    return m.id;
  });
});
afterEach(() => db.close());

describe('owner attachment store operations', () => {
  it('keeps shared content until the last stored row is freed and leaves the cap frontier unchanged', () => {
    setSetting(db, FRONTIER, TS - 1);
    expect(freeAttachments(db, dir, [IDS[0]!, IDS[0]!, 'unknown'])).toEqual({ freed: 1, bytes: 0, channelIds: ['c1'] });
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(true);
    expect(storedFileOf(db, IDS[0]!)).toBeNull();
    expect(freeAttachments(db, dir, IDS)).toEqual({ freed: 1, bytes: OLD_BYTES, channelIds: ['c2'] });
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(false);
    expect(getSetting(db, FRONTIER)).toBe(TS - 1);
    db.prepare("UPDATE attachments SET status = 'pending' WHERE id = ?").run(IDS[1]);
    skipPrunedPending(db);
    expect(db.prepare('SELECT status FROM attachments WHERE id = ?').pluck().get(IDS[1])).toBe('pending');
  });

  it('frees both shared rows in one transaction and counts disk bytes once', () => {
    expect(freeAttachments(db, dir, IDS)).toEqual({ freed: 2, bytes: OLD_BYTES, channelIds: ['c1', 'c2'] });
    expect(freeAttachments(db, dir, IDS)).toEqual({ freed: 0, bytes: 0, channelIds: [] });
    expect(getSetting(db, FRONTIER)).toBeUndefined();
  });

  it('repoints every stored row, removes all old extensions, and survives message derivation', () => {
    put(OLD_SHA, OLD_BYTES, 'jpg');
    const next = put(NEW_SHA, NEW_BYTES, 'webp');
    expect(replaceStoredFile(db, dir, REPLACEMENT, TS)).toEqual({ savedBytes: OLD_BYTES - NEW_BYTES, channelIds: ['c1', 'c2'] });
    for (const id of IDS) expect(storedFileOf(db, id)).toMatchObject({ sha256: NEW_SHA, storedExt: 'webp', storedBytes: NEW_BYTES, compressedAt: TS });
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(false);
    expect(existsSync(storedAttachmentPath(dir, file(OLD_SHA, 'jpg')))).toBe(false);
    expect(existsSync(next)).toBe(true);
    deriveMessage(db, { id: messageIds[0]!, channel_id: 'c1', attachments: [{ id: IDS[0]!, filename: 'picture.png', url: 'https://cdn.example/new' }] }, 'u1');
    expect(storedFileOf(db, IDS[0]!)).toMatchObject({ sha256: NEW_SHA, storedExt: 'webp', storedBytes: NEW_BYTES, compressedAt: TS });
    expect(messagesByIds(db, [messageIds[0]!])[0]!.attachments[0]).toMatchObject({ storedExt: 'webp', storedBytes: NEW_BYTES, compressed: true });
    expect(db.prepare('SELECT stored_ext, compressed_at, kind, ts FROM archive_all_attachments WHERE id = ?').get(IDS[0]))
      .toEqual({ stored_ext: 'webp', compressed_at: TS, kind: 'image', ts: TS });
    expect(enforceAttachmentCap(db, dir, 0)).toBe(NEW_BYTES);
    expect(existsSync(next)).toBe(false);
  });

  // Archives written before the store kept one file per hash may hold the same content under several extensions.
  it('counts and removes every extension copy of shared content when enforcing the cap', () => {
    db.prepare("UPDATE attachments SET filename = 'picture.jpg' WHERE id = ?").run(IDS[1]);
    const jpg = put(OLD_SHA, OLD_BYTES, 'jpg');
    expect(enforceAttachmentCap(db, dir, (OLD_BYTES + 1) / BYTES_PER_GB)).toBe(2 * OLD_BYTES);
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(false);
    expect(existsSync(jpg)).toBe(false);
  });

  it('removes an extension copy once no stored row names it, keeping the copies still named', () => {
    db.prepare("UPDATE attachments SET filename = 'picture.jpg' WHERE id = ?").run(IDS[1]);
    const jpg = put(OLD_SHA, OLD_BYTES, 'jpg');
    expect(freeAttachments(db, dir, [IDS[0]!])).toEqual({ freed: 1, bytes: OLD_BYTES, channelIds: ['c1'] });
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(false);
    expect(existsSync(jpg)).toBe(true);
  });

  it('records the stored file a download shares under another extension', () => {
    attachmentStored(db, dir, IDS[1]!, OLD_SHA, OLD_BYTES, 'png');
    expect(storedFileOf(db, IDS[1]!)).toMatchObject({ sha256: OLD_SHA, storedExt: 'png' });
    expect(() => attachmentStored(db, dir, IDS[1]!, OLD_SHA, OLD_BYTES, '../png')).toThrow(/extension/);
    expect(() => attachmentStored(db, dir, IDS[1]!, '../a', OLD_BYTES)).toThrow(/hash/);
  });

  it('refuses to record a download whose shared stored file was removed after the download found it', () => {
    db.prepare("UPDATE attachments SET status = 'pending', sha256 = NULL WHERE id = ?").run(IDS[1]);
    expect(freeAttachments(db, dir, [IDS[0]!])).toMatchObject({ bytes: OLD_BYTES });
    expect(() => attachmentStored(db, dir, IDS[1]!, OLD_SHA, OLD_BYTES)).toThrow(/gone/);
    expect(db.prepare('SELECT status FROM attachments WHERE id = ?').pluck().get(IDS[1])).toBe('pending');
  });

  it('refuses a missing, equal-sized, larger, or unknown-size re-encode without changing rows or files', () => {
    expect(() => replaceStoredFile(db, dir, REPLACEMENT, TS)).toThrow(/missing/);
    for (const bytes of [OLD_BYTES, OLD_BYTES + 1]) {
      put(NEW_SHA, bytes, 'webp');
      expect(() => replaceStoredFile(db, dir, { ...REPLACEMENT, bytes }, TS)).toThrow(/smaller/);
    }
    put(NEW_SHA, NEW_BYTES, 'webp');
    db.prepare('UPDATE attachments SET stored_bytes = NULL WHERE id = ?').run(IDS[1]);
    expect(() => replaceStoredFile(db, dir, REPLACEMENT, TS)).toThrow(/smaller/);
    expect(storedFileOf(db, IDS[0]!)?.sha256).toBe(OLD_SHA);
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(true);
  });

  it('on a refused re-encode, removes its file only while no stored row names that content', () => {
    const { attachmentRecompressed } = attachmentStoreHandlers(() => db, () => dir, () => undefined);
    const newFile = storedAttachmentPath(dir, file(NEW_SHA, 'webp'));
    db.prepare('UPDATE attachments SET stored_bytes = NULL WHERE id = ?').run(IDS[0]); // unknown size: refused
    put(NEW_SHA, NEW_BYTES, 'webp');
    db.prepare("UPDATE attachments SET sha256 = ?, stored_ext = 'webp', stored_bytes = ? WHERE id = ?").run(NEW_SHA, NEW_BYTES, IDS[1]); // a download reused it
    expect(() => attachmentRecompressed(REPLACEMENT)).toThrow(/smaller/);
    expect(existsSync(newFile)).toBe(true);
    db.prepare("UPDATE attachments SET status = 'evicted' WHERE id = ?").run(IDS[1]);
    expect(() => attachmentRecompressed(REPLACEMENT)).toThrow(/smaller/);
    expect(existsSync(newFile)).toBe(false);
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(true);
  });

  it('updates rows before disk removal, so a failed DB update keeps every file', () => {
    put(NEW_SHA, NEW_BYTES, 'webp');
    db.exec(`CREATE TRIGGER reject_attachment BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    expect(() => freeAttachments(db, dir, IDS)).toThrow('blocked');
    expect(() => replaceStoredFile(db, dir, REPLACEMENT, TS)).toThrow('blocked');
    expect(existsSync(storedAttachmentPath(dir, file()))).toBe(true);
    expect(storedFileOf(db, IDS[0]!)?.sha256).toBe(OLD_SHA);
  });

  it('validates desktop calls, emits each affected channel, and keeps replacement main-only', () => {
    const changed: string[] = [];
    const handlers = attachmentStoreHandlers(() => db, () => dir, (rows) => changed.push(rows.channelId));
    expect(() => handlers.freeAttachments(['bad'])).toThrow(/attachment id/);
    expect(() => handlers.freeAttachments(Array(FREE_ATTACHMENTS_MAX + 1).fill(IDS[0]))).toThrow(/bounded/);
    expect(handlers.storedFile(IDS[0]!)).toMatchObject(file());
    expect(() => handlers.storedFile('bad')).toThrow(/attachment id/);
    put(NEW_SHA, NEW_BYTES, 'webp');
    expect(handlers.attachmentRecompressed(REPLACEMENT)).toEqual({ savedBytes: OLD_BYTES - NEW_BYTES });
    expect(changed).toEqual(['c1', 'c2']);
    changed.length = 0;
    expect(handlers.freeAttachments(IDS)).toEqual({ freed: 2, bytes: NEW_BYTES });
    expect(changed).toEqual(['c1', 'c2']);
    for (const method of ['freeAttachments', 'storedFile']) {
      expect(RENDERER_CORE_METHODS).toContain(method);
      expect(PHONE_CORE_METHODS).not.toContain(method);
    }
    expect(RENDERER_CORE_METHODS).not.toContain('attachmentRecompressed');
    expect(PHONE_CORE_METHODS).not.toContain('attachmentRecompressed');
  });

  it('additively migrates attachment times and replaces stale views before ALTER TABLE', () => {
    const legacy = new Database(':memory:');
    try {
      // The schema just before stored_ext; later migrations add compressed_at, ts and more.
      const before = MIGRATIONS.indexOf('ALTER TABLE attachments ADD COLUMN stored_ext TEXT;');
      expect(before).toBeGreaterThan(0);
      for (const migration of MIGRATIONS.slice(0, before)) applyMigration(legacy, migration);
      legacy.pragma(`user_version = ${before}`);
      const orphan = snowflakeFromMs(TS);
      legacy.prepare("INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES ('message', 'c', 'u', ?, '', '{}')").run(TS);
      legacy.prepare("INSERT INTO attachments (id, message_id, channel_id, filename, url) VALUES (?, ?, 'c', 'a.png', 'url')").run('joined', 'message');
      legacy.prepare("INSERT INTO attachments (id, message_id, channel_id, filename, url) VALUES (?, ?, 'c', 'a.png', 'url')").run(orphan, 'missing');
      legacy.exec('CREATE VIEW archive_attachments AS SELECT obsolete FROM attachments');
      migrate(legacy);
      expect(legacy.prepare('SELECT ts FROM attachments ORDER BY id').pluck().all()).toEqual([TS, TS]);
      expect(legacy.prepare('SELECT stored_ext, compressed_at, kind FROM archive_all_attachments LIMIT 1').get())
        .toEqual({ stored_ext: null, compressed_at: null, kind: 'image' });
      expect(legacy.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'attachments_ts'").get()).toBeTruthy();
    } finally {
      legacy.close();
    }
  });
});
