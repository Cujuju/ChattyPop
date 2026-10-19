import { compressRawJson, type Db } from '../src/core/db';
import { seedArchive, tempDb } from './helpers';
import { PERMISSIONS } from '@shared/permissions';
import { MS_PER_DAY } from '@shared/units';

/** Synthetic known-channel count matches the reported archive scale. */
export const STARTUP_CHANNELS = 3457;
/** A few hundred thousand messages, including the ranking queries' full 20k lookback. */
export const STARTUP_MESSAGES = 400_000;
/** Busy-day lookback exercises the startup matcher without making all history recent. */
export const STARTUP_RECENT = 20_000;
/** Several guilds with substantial role catalogs expose repeated permission hydration. */
const GUILDS = 12;
const ROLES_PER_GUILD = 300;
/** Compressed rich payloads expose native JSON work at the ranking limit. */
const PAYLOAD_CHARS = 16_384;

export function startupFixture(): Db {
  const db = tempDb();
  seedArchive(db, []);
  const guild = db.prepare('INSERT OR REPLACE INTO guilds (id, name, owner_id) VALUES (?, ?, ?)');
  const role = db.prepare('INSERT INTO roles (id, guild_id, name, position, raw_json, color) VALUES (?, ?, ?, ?, ?, 0)');
  const member = db.prepare('INSERT INTO members (guild_id, user_id, roles, updated_at) VALUES (?, ?, ?, 0)');
  const channel = db.prepare('INSERT INTO channels (id, guild_id, name, kind, opted_in) VALUES (?, ?, ?, 0, 1)');
  const message = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
  const link = db.prepare("INSERT INTO links (id, url, platform, first_message_id, first_channel_id, first_author_id, first_ts) VALUES (?, ?, ?, ?, ?, 'owner', ?)");
  const share = db.prepare('INSERT INTO message_links (message_id, link_id) VALUES (?, ?)');
  const payload = compressRawJson(JSON.stringify({ content: 'x'.repeat(PAYLOAD_CHARS),
    application_id: 'app', interaction_metadata: { name: 'hello', user: { id: 'owner' }, type: 2 },
    reactions: [{ emoji: { id: 'emoji', name: 'wave' }, me: true }] }));
  const now = Date.now();
  db.transaction(() => {
    for (let g = 0; g < GUILDS; g++) {
      const id = `g${g}`;
      guild.run(id, id, 'admin');
      member.run(id, 'owner', '[]');
      for (let r = 0; r < ROLES_PER_GUILD; r++) role.run(r ? `${id}r${r}` : id, id, `Role ${r}`, r,
        JSON.stringify({ permissions: String(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY) }));
    }
    for (let c = 0; c < STARTUP_CHANNELS; c++) channel.run(`c${c}`, `g${c % GUILDS}`, `Channel ${c}`);
    for (let n = 0; n < STARTUP_MESSAGES; n++) {
      const recent = n >= STARTUP_MESSAGES - STARTUP_RECENT;
      const ts = recent ? now - (STARTUP_MESSAGES - n) : now - MS_PER_DAY - n;
      message.run(String(n), `c${n % STARTUP_CHANNELS}`, 'owner', ts, 'Hello 🔥 <:wave:emoji>', payload);
      if (recent) {
        link.run(n, `https://example.com/${n}`, 'web', String(n), `c${n % STARTUP_CHANNELS}`, ts);
        share.run(String(n), n);
      }
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}
