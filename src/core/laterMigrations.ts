// Later archive schema migrations.
import { upgradeRuleSpec } from '@shared/ruleUpgrade';
import type { Db } from './db';
import { createMessagePings } from './derive/pings';
import { rawJsonText } from './rawJson';
import { HIDDEN_SCOPE_RENAMES, HIDDEN_SCOPE_TABLE } from './hiddenScope';
import { refreshLinkSearch } from './linkSearch';
import type { Migration } from './migrations';
import { topicsIntoRules } from './topicsIntoRules';

/**
 * Alert snippets stored before cuts kept Discord tokens whole: drop a token cut at either end (a leading
 * "…name:123>" or a trailing "<:name:12…"), so the rest renders. Frozen: its own patterns, not the live ones.
 */
export function trimCutSnippetTokens(db: Db): void {
  const leading = /^…(?=[\w:!&@#-]*\d)[\w:!&@#-]*>/;
  const trailing = /<(?:a?:|@|#|t:)[\w:!&-]*…$/;
  const rows = db.prepare(`SELECT id, snippet FROM alerts WHERE snippet LIKE '%<%' OR snippet LIKE '%>%'`).all() as { id: number; snippet: string }[];
  const update = db.prepare('UPDATE alerts SET snippet = ? WHERE id = ?');
  for (const r of rows) {
    const tidy = r.snippet.replace(leading, '…').replace(trailing, '…');
    if (tidy !== r.snippet) update.run(tidy, r.id);
  }
}

/**
 * A step for a plugin's former host code, emptied: its version stays and fresh profiles skip it. A profile created
 * before such a step but not yet past it keeps that code's data unconverted; none shipped publicly.
 */
export const RETIRED: Migration = '';

/**
 * A step that only created or refreshed the archive views, emptied: openDb installs the current views after every
 * upgrade (archiveViews.ts), so no step builds them against an intermediate schema. Its version stays.
 */
export const VIEWS_AT_OPEN: Migration = '';

/** Migrations after EARLY_MIGRATIONS (migrations.ts), in order. Never edit a shipped entry, append instead. */
/**
 * Link text (docs/plugin-architecture.md → Links): a plugin's text for a link (a fetched X post), read as what messages
 * link to. Posts fetched before Links was a plugin move here from x_posts; a build that already adopted x_posts skips
 * that. Frozen: the Links plugin's id, x_posts' shape and the X post URL form.
 */
export function linkTexts(db: Db): void {
  db.exec('CREATE TABLE link_texts (url TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (url, source))');
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'x_posts'`).get()) return;
  db.exec(`INSERT INTO link_texts (url, source, text)
             SELECT 'https://x.com/i/status/' || status_id, 'links', json_extract(status_json, '$.text') FROM x_posts
             WHERE state = 'ok' AND json_extract(status_json, '$.text') != ''`);
}

export const LATER_MIGRATIONS: readonly Migration[] = [
  `
  -- How a message first reached ChattyPop: gateway (the live tap) | sync (a history fetch) | import (a file).
  -- NULL for messages stored before: unknown, so never live.
  ALTER TABLE messages ADD COLUMN arrived_via TEXT;
  `,
  `
  -- The owner's rules. spec: RuleSpec JSON (spec.v is its format version). armed_at: only messages sent after it act.
  -- discord_send: the owner's opt-in to the rule posting to Discord as them. position: run order for one event.
  CREATE TABLE rules (id INTEGER PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                      position INTEGER NOT NULL, armed_at INTEGER NOT NULL, discord_send INTEGER NOT NULL DEFAULT 0,
                      created_at INTEGER NOT NULL);
  -- A rule firing on one event, claimed before its actions run so an event fires a rule once. event_key: msg:<id> or
  -- tag:<message id>:<tag id>. live: 0 for a backfilled or re-asked message.
  CREATE TABLE rule_runs (id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
                          event_key TEXT NOT NULL, message_id TEXT, channel_id TEXT, live INTEGER NOT NULL, at INTEGER NOT NULL,
                          UNIQUE (rule_id, event_key));
  CREATE INDEX rule_runs_rule_at ON rule_runs(rule_id, at);
  -- Each action's result in a run. outcome: done | skipped | failed; detail says why. action_id: stable id in the spec.
  CREATE TABLE rule_action_runs (run_id INTEGER NOT NULL REFERENCES rule_runs(id) ON DELETE CASCADE, action_id TEXT NOT NULL,
                                 kind TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL,
                                 PRIMARY KEY (run_id, action_id));
  -- Cooldowns (per action) and the Discord post budget (per kind) count recent done actions.
  CREATE INDEX rule_action_runs_kind_at ON rule_action_runs(kind, outcome, at);
  CREATE INDEX rule_action_runs_action_at ON rule_action_runs(action_id, outcome, at);
  `,
  `
  -- An alert comes from a topic or from a rule's notify action, exactly one. Rebuilt because topic_id was NOT NULL.
  -- match_kind 'rule': a rule's alert. A rule's alerts go with it.
  CREATE TABLE alerts_rebuilt (id INTEGER PRIMARY KEY, topic_id INTEGER, rule_id INTEGER REFERENCES rules(id) ON DELETE CASCADE,
                               message_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, ts INTEGER NOT NULL,
                               snippet TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
                               match_kind TEXT NOT NULL DEFAULT 'pattern', probability REAL, duplicate_of INTEGER,
                               CHECK ((topic_id IS NULL) <> (rule_id IS NULL)), UNIQUE (topic_id, message_id), UNIQUE (rule_id, message_id));
  INSERT INTO alerts_rebuilt (id, topic_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of)
    SELECT id, topic_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of FROM alerts;
  DROP TABLE alerts;
  ALTER TABLE alerts_rebuilt RENAME TO alerts;
  CREATE INDEX alerts_ts ON alerts(ts);
  CREATE INDEX alerts_unread ON alerts(read_at) WHERE read_at IS NULL;
  `,
  RETIRED,
  // Topics become rules (a conversion SQL can't express: rule JSON built from each topic).
  topicsIntoRules,
  trimCutSnippetTokens,
  RETIRED,
  `
  -- Derived text (docs/research.md §7.1 → Wave 2): text a plugin makes for a message (a transcript), kept and indexed
  -- here. source: '<plugin id>:<its key>'; ord: its place after the content. Transcripts become the transcription
  -- plugin's table; their done texts move here with their order and FTS rowid, so reads and search rank as before.
  CREATE TABLE derived_texts (seq INTEGER PRIMARY KEY, message_id TEXT NOT NULL, source TEXT NOT NULL UNIQUE, ord INTEGER NOT NULL, text TEXT NOT NULL);
  CREATE INDEX derived_texts_message ON derived_texts(message_id);
  CREATE VIRTUAL TABLE fts_derived_texts USING fts5(text, content='derived_texts', content_rowid='seq');
  CREATE TRIGGER derived_texts_ai AFTER INSERT ON derived_texts BEGIN
    INSERT INTO fts_derived_texts(rowid, text) VALUES (new.seq, new.text);
  END;
  CREATE TRIGGER derived_texts_ad AFTER DELETE ON derived_texts BEGIN
    INSERT INTO fts_derived_texts(fts_derived_texts, rowid, text) VALUES ('delete', old.seq, old.text);
  END;
  CREATE TRIGGER derived_texts_au AFTER UPDATE OF text ON derived_texts BEGIN
    INSERT INTO fts_derived_texts(fts_derived_texts, rowid, text) VALUES ('delete', old.seq, old.text);
    INSERT INTO fts_derived_texts(rowid, text) VALUES (new.seq, new.text);
  END;
  INSERT INTO derived_texts (seq, message_id, source, ord, text)
    SELECT seq, message_id, 'transcription:' || attachment_id, seq, text FROM transcripts WHERE state = 'done' AND text IS NOT NULL;
  DROP TRIGGER transcripts_ai;
  DROP TRIGGER transcripts_ad;
  DROP TRIGGER transcripts_au;
  DROP TABLE fts_transcripts;
  `,
  linkTexts,
  migrateRuleSpecs,
  VIEWS_AT_OPEN,
  VIEWS_AT_OPEN,
  parkSummarySettings,
  parkOllamaSettings,
  // A link's shares by link (the Links feed's share counts and preview cards); the primary key serves only by message.
  'CREATE INDEX message_links_link ON message_links (link_id, message_id);',
  VIEWS_AT_OPEN,
  HIDDEN_SCOPE_TABLE,
  HIDDEN_SCOPE_RENAMES,
  // An action that sat out a timed run it was claimed in (its plugin turned off first): the run isn't its progress.
  'ALTER TABLE rule_action_runs ADD COLUMN sat_out INTEGER NOT NULL DEFAULT 0;',
  // The archive's newest messages across channels (the owner's most-used reactions) without sorting every message.
  'CREATE INDEX messages_ts ON messages (ts);',
  discordNameStyles,
  discordNameEffects,
  // A one-to-one DM's other person (users row), from the DM list's recipients: the DM's avatar before any message is stored.
  'ALTER TABLE channels ADD COLUMN peer_id TEXT;',
  // A group DM's icon hash, from the DM list.
  'ALTER TABLE channels ADD COLUMN icon TEXT;',
  // Images a plugin found for a link (a fetched X post's photos), in the order the post shows them.
  `CREATE TABLE link_images (url TEXT NOT NULL, source TEXT NOT NULL, ord INTEGER NOT NULL, image_url TEXT NOT NULL,
                             width INTEGER, height INTEGER, PRIMARY KEY (url, source, ord));`,
  `
  -- Discord's own answers, cached so they show at once and offline; fetched_at: when Discord answered.
  -- A profile per person and server ('' outside one): Discord's JSON whole, the owner's note, friends-since (ms).
  CREATE TABLE discord_profiles (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, profile_json TEXT NOT NULL, note TEXT,
                                 friends_since INTEGER, fetched_at INTEGER NOT NULL, PRIMARY KEY (user_id, guild_id));
  -- Friends the owner shares with a person (user_ids: JSON array, Discord's order).
  CREATE TABLE discord_mutual_friends (user_id TEXT PRIMARY KEY, user_ids TEXT NOT NULL, fetched_at INTEGER NOT NULL);
  -- The first reactors of one emoji on a message; count: the reaction's count Discord's answer belongs to.
  CREATE TABLE reactors (message_id TEXT NOT NULL, emoji_key TEXT NOT NULL, user_ids TEXT NOT NULL, count INTEGER NOT NULL,
                         fetched_at INTEGER NOT NULL, PRIMARY KEY (message_id, emoji_key));
  `,
  // Who each message pinged, for the sidebar's unread @mention count.
  createMessagePings,
  `
  -- Each channel's unread mention count in Discord's read state, kept by main from the gateway; replaces message_pings.
  -- A channel without a row has none.
  DROP TABLE message_pings;
  CREATE TABLE read_states (channel_id TEXT PRIMARY KEY, mention_count INTEGER NOT NULL) WITHOUT ROWID;
  `,
  // Search reads what a message links to (embed previews, fetched posts).
  refreshLinkSearch,
  // A channel's speakers and when each last spoke (the composer's `@` suggestions) without reading its every message.
  'CREATE INDEX messages_channel_author ON messages (channel_id, author_id, ts);',
  // Who can see a channel (the composer's `@` suggestions): the server's owner, and the channel's permission overwrites (JSON).
  'ALTER TABLE guilds ADD COLUMN owner_id TEXT;',
  'ALTER TABLE channels ADD COLUMN overwrites TEXT;',
  // When a member left their server (GUILD_MEMBER_REMOVE); NULL while they are in it. A left member can't be mentioned.
  'ALTER TABLE members ADD COLUMN left_at INTEGER;',
  // A DM's or group DM's current people (JSON user ids), from the DM list: who its `@` offers.
  'ALTER TABLE channels ADD COLUMN recipients TEXT;',
  `
  -- Direct messages from the client's gateway (docs/dms.md §3.2); additive: other builds share the profile.
  -- account_id: the signed-in user a DM belongs to. last_message_id only rises. closed_at: ms it left Discord's list.
  ALTER TABLE channels ADD COLUMN account_id TEXT;
  ALTER TABLE channels ADD COLUMN last_message_id TEXT;
  ALTER TABLE channels ADD COLUMN owner_id TEXT;
  ALTER TABLE channels ADD COLUMN closed_at INTEGER;
  -- Discord's is_message_request and is_spam, each kept apart (a payload may carry one); either makes it a request.
  -- auto_declined: the owner declined archiving it, so auto-archive skips it.
  ALTER TABLE channels ADD COLUMN is_message_request INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN auto_declined INTEGER NOT NULL DEFAULT 0;
  -- A DM's last read message, and when its mute ends (ms; MUTED_FOREVER: until unmuted).
  ALTER TABLE read_states ADD COLUMN ack_id TEXT;
  ALTER TABLE read_states ADD COLUMN mute_ends_ms INTEGER;
  `,
  // The message part a derived text is of (messageParts partKey): another plugin (translation) reads texts per part.
  'ALTER TABLE derived_texts ADD COLUMN part TEXT;',
  // When a member's timeout ends (epoch ms); a timed-out owner can't mention @everyone (shared/permissions.ts).
  'ALTER TABLE members ADD COLUMN timed_out_until INTEGER;',
];

/**
 * Discord's name styling: a member's role ids (JSON array; NULL until a payload carried them), each server's
 * roles, and the server tag a user shows. Filled from each author's newest archived payload; live events keep them current.
 */
export function discordNameStyles(db: Db): void {
  // openDb registers msg_json after migrating; a migration run elsewhere (tests) has none.
  db.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
  db.exec(`
    ALTER TABLE members ADD COLUMN roles TEXT;
    CREATE TABLE roles (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
                        color INTEGER NOT NULL, icon TEXT, unicode_emoji TEXT, raw_json TEXT NOT NULL);
    CREATE INDEX roles_guild ON roles (guild_id);
    ALTER TABLE users ADD COLUMN tag_guild_id TEXT;
    ALTER TABLE users ADD COLUMN tag TEXT;
    ALTER TABLE users ADD COLUMN tag_badge TEXT;
  `);
  // Only live messages carry the member; the newest one per server and author holds its latest roles. Temp tables keep
  // each payload decoded once (a CTE in a correlated subquery may be re-run per row).
  db.exec(`
    CREATE TEMP TABLE latest_roles AS
      SELECT l.guild_id, l.author_id, json_extract(msg_json(m.raw_json), '$.member.roles') AS roles
      FROM (SELECT c.guild_id, m.author_id, MAX(m.seq) AS seq FROM messages m JOIN channels c ON c.id = m.channel_id
            WHERE m.arrived_via = 'gateway' AND c.guild_id IS NOT NULL GROUP BY c.guild_id, m.author_id) l
      JOIN messages m ON m.seq = l.seq;
    CREATE UNIQUE INDEX temp.latest_roles_key ON latest_roles (guild_id, author_id);
    UPDATE members SET roles = (SELECT roles FROM latest_roles r WHERE r.guild_id = members.guild_id AND r.author_id = members.user_id);
    DROP TABLE latest_roles;
    CREATE TEMP TABLE latest_tags AS
      SELECT author_id, json_extract(g, '$.identity_guild_id') AS guild_id, json_extract(g, '$.tag') AS tag, json_extract(g, '$.badge') AS badge
      FROM (SELECT l.author_id, json_extract(msg_json(m.raw_json), '$.author.primary_guild') AS g
            FROM (SELECT author_id, MAX(seq) AS seq FROM messages GROUP BY author_id) l JOIN messages m ON m.seq = l.seq)
      WHERE json_extract(g, '$.identity_enabled') IS NOT 0 AND json_extract(g, '$.tag') IS NOT NULL AND json_extract(g, '$.identity_guild_id') IS NOT NULL;
    CREATE UNIQUE INDEX temp.latest_tags_key ON latest_tags (author_id);
    UPDATE users SET (tag_guild_id, tag, tag_badge) = (SELECT guild_id, tag, badge FROM latest_tags t WHERE t.author_id = users.id)
      WHERE id IN (SELECT author_id FROM latest_tags);
    DROP TABLE latest_tags;
  `);
}

/**
 * The rest of Discord's name styling: a server's features (gradient role colours need one), and a user's
 * display-name style (font, effect, colours: JSON) and avatar decoration (asset hash). Filled from each author's newest payload.
 */
export function discordNameEffects(db: Db): void {
  db.function('msg_json', { deterministic: true }, (v: unknown) => rawJsonText(v as string | Buffer | null));
  db.exec(`
    ALTER TABLE guilds ADD COLUMN features TEXT;
    ALTER TABLE users ADD COLUMN name_style TEXT;
    ALTER TABLE users ADD COLUMN decoration TEXT;
    CREATE TEMP TABLE latest_author AS
      SELECT l.author_id, json_extract(msg_json(m.raw_json), '$.author.display_name_styles') AS style,
             json_extract(msg_json(m.raw_json), '$.author.avatar_decoration_data.asset') AS decoration
      FROM (SELECT author_id, MAX(seq) AS seq FROM messages GROUP BY author_id) l JOIN messages m ON m.seq = l.seq;
    CREATE UNIQUE INDEX temp.latest_author_key ON latest_author (author_id);
    UPDATE users SET (name_style, decoration) = (SELECT style, decoration FROM latest_author a WHERE a.author_id = users.id)
      WHERE id IN (SELECT author_id FROM latest_author);
    DROP TABLE latest_author;
  `);
}

/** Rewrites every stored rule to v4 so SQL readers see one shape, independent of installed plugin kinds. */
export function migrateRuleSpecs(db: Db): void {
  const rows = db.prepare('SELECT id, spec, builtin FROM rules').all() as {
    id: number;
    spec: string;
    builtin: string | null;
  }[];
  const update = db.prepare('UPDATE rules SET spec = ? WHERE id = ?');
  for (const row of rows) update.run(JSON.stringify(upgradeRuleSpec(row.spec, row.builtin)), row.id);
}

/** Keeps Ollama's address, which left the AI settings for the Ollama plugin, in builds without it. Frozen key names. */
export function parkOllamaSettings(db: Db): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined;
  const ai: unknown = row ? JSON.parse(row.value) : null;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return;
  const { ollamaUrl, ...rest } = ai as Record<string, unknown>;
  if (ollamaUrl === undefined) return;
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('legacy.ollamaSettings', ?)").run(JSON.stringify({ ollamaUrl }));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ai'").run(JSON.stringify(rest));
}

/** Preserve extracted preferences even in builds without Summaries. Frozen key names. */
export function parkSummarySettings(db: Db): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined;
  const ai: unknown = row ? JSON.parse(row.value) : null;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return;
  const { skipObviousFiller, jevRouting, ...rest } = ai as Record<string, unknown>;
  if (skipObviousFiller === undefined && jevRouting === undefined) return;
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('legacy.summarySettings', ?)")
    .run(JSON.stringify({ skipObviousFiller, jevRouting }));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ai'").run(JSON.stringify(rest));
}
