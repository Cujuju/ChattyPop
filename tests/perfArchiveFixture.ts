// Deterministic host archive with servers, threads, DMs, links, and judgements for query-plan and parity tests. Plugin tests add their own rows.
import type { Db } from '../src/core/db';

/** Row counts to seed; `REAL_ARCHIVE` matches the archive the review measured. */
export interface PerfScale {
  messages: number;
  judgments: number;
}
export const REAL_ARCHIVE: PerfScale = { messages: 34_000, judgments: 50_000 };
/** Fixture scale distinguishes scan and indexed query plans. */
export const TEST_ARCHIVE: PerfScale = { messages: 3_000, judgments: 4_000 };

const GUILDS = 3;
const CHANNELS_PER_GUILD = 12;
/** Every fourth channel has a thread under it. */
const THREAD_EVERY = 4;
const DM_CHANNELS = 4;
const USERS = 120;
/** Every Nth message shares a link; every Mth of those a link another message already shared. */
const LINK_EVERY = 5;
const RESHARE_EVERY = 3;
/** Every Nth message mentions a channel, which privacy mode may hide. */
const MENTION_EVERY = 17;
const JUDGMENT_SUBJECTS = ['aimed', 'question', 'urgency', 'topic:1', 'topic:2'];
/** First seeded message time; each subsequent message advances by STEP_MINUTES. */
export const START_TS = Date.UTC(2024, 0, 1);
const MINUTE_MS = 60_000;
const STEP_MINUTES = 29;

/** Seeds `db` (already migrated) with `scale` rows; ids are stable across calls with the same scale. */
export function seedPerfArchive(db: Db, scale: PerfScale): { channels: string[]; guilds: string[]; threads: string[] } {
  const guilds = Array.from({ length: GUILDS }, (_, g) => `g${g}`);
  const channels: string[] = [];
  const threads: string[] = [];
  db.transaction(() => {
    const guild = db.prepare('INSERT INTO guilds (id, name) VALUES (?, ?)');
    const channel = db.prepare('INSERT INTO channels (id, guild_id, name, kind, parent_id, opted_in) VALUES (?, ?, ?, ?, ?, 1)');
    for (const g of guilds) {
      guild.run(g, `Guild ${g}`);
      for (let c = 0; c < CHANNELS_PER_GUILD; c++) {
        const id = `${g}c${c}`;
        channel.run(id, g, `chan-${id}`, 0, null);
        channels.push(id);
        if (c % THREAD_EVERY === 0) {
          channel.run(`${id}t`, g, `thread-${id}`, 11, id);
          threads.push(`${id}t`);
        }
      }
    }
    for (let d = 0; d < DM_CHANNELS; d++) {
      channel.run(`dm${d}`, null, `dm-${d}`, 1, null);
      channels.push(`dm${d}`);
    }
    const all = [...channels, ...threads];
    const user = db.prepare('INSERT INTO users (id, username, global_name) VALUES (?, ?, ?)');
    for (let u = 0; u < USERS; u++) user.run(`u${u}`, `user${u}`, u % 2 ? `User ${u}` : null);
    const message = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content) VALUES (?, ?, ?, ?, ?)');
    const link = db.prepare(`INSERT INTO links (id, url, platform, first_message_id, first_channel_id, first_author_id, first_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const share = db.prepare('INSERT INTO message_links (message_id, link_id) VALUES (?, ?)');
    let links = 0;
    for (let i = 0; i < scale.messages; i++) {
      const id = `m${i}`;
      const ch = all[(i * 7) % all.length]!;
      const author = `u${(i * 13) % USERS}`;
      const ts = START_TS + i * STEP_MINUTES * MINUTE_MS;
      const mention = i % MENTION_EVERY === 0 ? ` see <#${all[i % all.length]}>` : '';
      let content = `message ${i} about topic ${i % 50}${mention}`;
      if (i % LINK_EVERY === 0) {
        const reshare = links > 0 && (i / LINK_EVERY) % RESHARE_EVERY === 0;
        const linkId = reshare ? 1 + ((i * 31) % links) : ++links;
        const url = `https://site${linkId % 40}.example/post/${linkId}`;
        content += ` ${url}`;
        message.run(id, ch, author, ts, content);
        if (!reshare) link.run(linkId, url, linkId % 3 ? 'other' : 'youtube', id, ch, author, ts);
        share.run(id, linkId);
      } else {
        message.run(id, ch, author, ts, content);
      }
    }
    const judgment = db.prepare('INSERT INTO jev_judgments (message_id, subject, value, model, judged_at) VALUES (?, ?, ?, ?, ?)');
    for (let j = 0; j < scale.judgments; j++) {
      const subject = JUDGMENT_SUBJECTS[j % JUDGMENT_SUBJECTS.length]!;
      judgment.run(`m${Math.floor(j / JUDGMENT_SUBJECTS.length) % scale.messages}`, subject, (j % 10) / 10, 'model', START_TS);
    }
  })();
  return { channels, guilds, threads };
}

/** Privacy mode on, hiding one server, one channel (and so its thread) and nothing else. */
export function hideSome(db: Db, fixture: { channels: string[]; guilds: string[] }): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('privacyMode', 'true')").run();
  db.prepare('UPDATE guilds SET hide_in_privacy = 1 WHERE id = ?').run(fixture.guilds[1]);
  db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run(fixture.channels[0]);
}
