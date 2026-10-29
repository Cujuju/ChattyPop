// Upgrading an old profile holding damaged payloads (malformed text, a BLOB that won't decompress): the migrations that seed
// from payloads skip those rows and seed the rest as before.
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/core/migrations';
import { applyMigrations, migrationIndex, tempDir } from './helpers';

const GUILD = 'g1';
const CHANNEL = 'c1';
const DAMAGED: readonly (string | Buffer)[] = ['{"member": {"nick": "cut off', Buffer.from('not zstd')];
const VALID = {
  member: { nick: 'Nick', roles: ['r1'] },
  author: {
    id: 'a0', bot: true, display_name_styles: { font_id: 1 }, avatar_decoration_data: { asset: 'deco' },
    primary_guild: { identity_guild_id: GUILD, identity_enabled: true, tag: 'TAG', badge: 'badge' },
  },
};

describe('payload-seeding migrations over damaged payloads', () => {
  it('upgrade the profile, seeding from the readable payloads', () => {
    const db = new Database(join(tempDir(), 'archive.db'));
    const members = migrationIndex('CREATE TABLE members');
    const arrivedVia = migrationIndex('ADD COLUMN arrived_via');
    applyMigrations(db, 0, members);
    db.prepare("INSERT INTO guilds (id, name) VALUES (?, 'G')").run(GUILD);
    db.prepare("INSERT INTO channels (id, guild_id, name, kind) VALUES (?, ?, 'c', 0)").run(CHANNEL, GUILD);
    const message = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, ?, \'\', ?)');
    const user = db.prepare("INSERT INTO users (id, username) VALUES (?, 'u')");
    [JSON.stringify(VALID), ...DAMAGED].forEach((raw, i) => {
      user.run(`a${i}`);
      message.run(`${i + 1}`, CHANNEL, `a${i}`, i + 1, raw);
    });
    applyMigrations(db, members, arrivedVia + 1);
    db.exec("UPDATE messages SET arrived_via = 'gateway'");
    applyMigrations(db, arrivedVia + 1, MIGRATIONS.length);
    expect(db.prepare('SELECT user_id, nick, roles FROM members').all()).toEqual([{ user_id: 'a0', nick: 'Nick', roles: '["r1"]' }]);
    expect(db.prepare('SELECT id, bot, tag, name_style IS NOT NULL AS styled, decoration FROM users ORDER BY id').all()).toEqual([
      { id: 'a0', bot: 1, tag: 'TAG', styled: 1, decoration: 'deco' },
      { id: 'a1', bot: 0, tag: null, styled: 0, decoration: null },
      { id: 'a2', bot: 0, tag: null, styled: 0, decoration: null },
    ]);
  });
});
