import type { Db } from './db';
import { LATER_MIGRATIONS, RETIRED } from './laterMigrations';

/** One schema step: SQL, or a conversion SQL can't express. Each runs in its own transaction. */
export type Migration = string | ((db: Db) => void);

/** Migrations up to privacy mode; later ones continue in laterMigrations.ts. Never edit a shipped entry, except to retire it. */
const EARLY_MIGRATIONS: readonly Migration[] = [
  `
  CREATE TABLE guilds   (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, raw_json TEXT);
  CREATE TABLE channels (id TEXT PRIMARY KEY, guild_id TEXT, name TEXT NOT NULL, kind INTEGER NOT NULL,
                         parent_id TEXT, opted_in INTEGER NOT NULL DEFAULT 0, raw_json TEXT);
  CREATE TABLE users    (id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, avatar TEXT);
  -- seq: explicit INTEGER PRIMARY KEY so FTS rowids stay stable across VACUUM (implicit rowids may not).
  CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
                         author_id TEXT NOT NULL, ts INTEGER NOT NULL, edited_ts INTEGER, deleted_at INTEGER,
                         content TEXT NOT NULL, raw_json TEXT);
  CREATE INDEX messages_channel_ts ON messages(channel_id, ts);
  CREATE TABLE message_revisions (message_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
                         edited_ts INTEGER, content TEXT NOT NULL,
                         PRIMARY KEY (message_id, seen_at));
  CREATE VIRTUAL TABLE fts_messages USING fts5(content, content='messages', content_rowid='seq');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO fts_messages(rowid, content) VALUES (new.seq, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO fts_messages(fts_messages, rowid, content) VALUES ('delete', old.seq, old.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO fts_messages(fts_messages, rowid, content) VALUES ('delete', old.seq, old.content);
    INSERT INTO fts_messages(rowid, content) VALUES (new.seq, new.content);
  END;
  `,
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE channels ADD COLUMN position INTEGER;
  ALTER TABLE channels ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;
  `,
  // Sync cursors bound the contiguous range fetched by sync. Live events may insert outside it,
  // so cursors must never be derived from MIN/MAX of stored messages.
  `
  ALTER TABLE channels ADD COLUMN sync_newest_id TEXT;
  ALTER TABLE channels ADD COLUMN sync_oldest_id TEXT;
  UPDATE channels SET backfill_complete = 0;
  `,
  `
  -- status: pending → stored | failed. Files live at media/attachments/<sha256[0:2]>/<sha256>.
  CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
                            filename TEXT NOT NULL, content_type TEXT, size INTEGER, width INTEGER, height INTEGER,
                            url TEXT NOT NULL, sha256 TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT);
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_pending ON attachments(status) WHERE status = 'pending';
  CREATE TABLE links (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, platform TEXT NOT NULL,
                      title TEXT, description TEXT, thumbnail_url TEXT, site TEXT,
                      first_message_id TEXT NOT NULL, first_channel_id TEXT NOT NULL,
                      first_author_id TEXT NOT NULL, first_ts INTEGER NOT NULL);
  CREATE INDEX links_first_ts ON links(first_ts);
  CREATE TABLE message_links (message_id TEXT NOT NULL, link_id INTEGER NOT NULL, PRIMARY KEY (message_id, link_id));
  `,
  `
  -- cache_key identifies (provider, model, range, channels, newest message, prompt version): same key, same answer.
  CREATE TABLE summaries (id INTEGER PRIMARY KEY, cache_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
                          provider TEXT NOT NULL, model TEXT, since_ts INTEGER NOT NULL, until_ts INTEGER NOT NULL,
                          channel_ids TEXT NOT NULL, message_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
                          headline TEXT NOT NULL, items_json TEXT NOT NULL);
  CREATE INDEX summaries_created ON summaries(created_at);
  -- Bytes actually written to the media store (identical files share one sha256 file).
  ALTER TABLE attachments ADD COLUMN stored_bytes INTEGER;
  UPDATE attachments SET stored_bytes = size WHERE status = 'stored';
  `,
  `
  -- Custom emoji referenced by archived messages (text or reactions); files at media/emojis/<id>.<gif|webp>.
  CREATE TABLE emojis (id TEXT PRIMARY KEY, name TEXT NOT NULL, animated INTEGER NOT NULL,
                       status TEXT NOT NULL DEFAULT 'pending', error TEXT);
  CREATE INDEX emojis_pending ON emojis(status) WHERE status = 'pending';
  `,
  `
  -- Tokens the provider reported for a summary run (all calls); NULL = not reported.
  ALTER TABLE summaries ADD COLUMN input_tokens INTEGER;
  ALTER TABLE summaries ADD COLUMN cached_input_tokens INTEGER;
  ALTER TABLE summaries ADD COLUMN output_tokens INTEGER;
  CREATE INDEX summaries_provider_created ON summaries(provider, created_at);
  `,
  `
  -- Watched topics (channel_ids JSON array, NULL = all) and their matches. An alert is unread while read_at IS NULL.
  CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, pattern TEXT NOT NULL, channel_ids TEXT,
                       cooldown_ms INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
  CREATE TABLE alerts (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
                       author_id TEXT NOT NULL, ts INTEGER NOT NULL, snippet TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
                       UNIQUE (topic_id, message_id));
  CREATE INDEX alerts_ts ON alerts(ts);
  CREATE INDEX alerts_unread ON alerts(read_at) WHERE read_at IS NULL;
  `,
  `
  -- Emoji are now cached at a higher resolution in a new directory: queue them all again.
  UPDATE emojis SET status = 'pending', error = NULL;
  `,
  `
  -- Jev: topics can match by a plain-language description; meaning alerts keep Jev's probability for re-tuning.
  ALTER TABLE topics ADD COLUMN description TEXT;
  ALTER TABLE alerts ADD COLUMN match_kind TEXT NOT NULL DEFAULT 'pattern';
  ALTER TABLE alerts ADD COLUMN probability REAL;
  -- Summaries: messages Jev left out, and what Jev cost (USD).
  ALTER TABLE summaries ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE summaries ADD COLUMN jev_cost_usd REAL;
  `,
  `
  -- When the owner last opened each channel in the Archive: its "new" count is messages after this.
  ALTER TABLE channels ADD COLUMN viewed_at INTEGER;
  `,
  `
  -- Text retention (summary-only tier) removed this message's text and payload; the row stays so citations resolve.
  ALTER TABLE messages ADD COLUMN pruned_at INTEGER;
  `,
  `
  -- Notes plugins attach to messages (PluginApi.annotate); one per plugin, message and label.
  CREATE TABLE plugin_annotations (plugin_id TEXT NOT NULL, message_id TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL,
                                   created_at INTEGER NOT NULL, PRIMARY KEY (plugin_id, message_id, label));
  CREATE INDEX plugin_annotations_message ON plugin_annotations(message_id);
  `,
  `
  -- Caches FxTwitter posts by post id. ok stores status_json; unavailable is terminal; errors retry. Link re-derivation preserves cached posts.
  --
  --
  CREATE TABLE x_posts (status_id TEXT PRIMARY KEY, state TEXT NOT NULL, status_json TEXT, fetched_at INTEGER NOT NULL);
  `,
  `
  -- Stores all Jev judgments for threshold changes without new requests. Subjects include topic meaning, urgency and owner-directed probability.
  --
  CREATE TABLE jev_judgments (message_id TEXT NOT NULL, subject TEXT NOT NULL, value REAL NOT NULL, model TEXT NOT NULL,
                              judged_at INTEGER NOT NULL, PRIMARY KEY (message_id, subject));
  CREATE INDEX jev_judgments_subject ON jev_judgments(subject);
  -- Topics ChattyPop manages itself ('aimed_at_me'); NULL = made by the user.
  ALTER TABLE topics ADD COLUMN builtin TEXT;
  `,
  `
  -- Per-channel policy (threads follow their parent): messages only ever go to a local model; an own text tier.
  ALTER TABLE channels ADD COLUMN local_ai_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN text_tier TEXT;
  `,
  `
  -- Jev choice answers keep the chosen option (value holds its probability).
  ALTER TABLE jev_judgments ADD COLUMN label TEXT;
  -- A topic can match by the owner's own Jev question (JSON: type, question, criteria, alert condition).
  ALTER TABLE topics ADD COLUMN jev_question TEXT;
  -- Key themes of a summary (JSON [{ title, citations }]); NULL when not asked.
  ALTER TABLE summaries ADD COLUMN themes_json TEXT;
  -- A live alert Jev judged the same event as an earlier alert of its topic (no second notification).
  ALTER TABLE alerts ADD COLUMN duplicate_of INTEGER;
  `,
  `
  -- Jev link judgments store category, risk probabilities and worth level. Canonical URLs retain identity when link ids change during re-derivation.
  --
  CREATE TABLE link_judgments (url TEXT PRIMARY KEY, category TEXT, flagged REAL, worth REAL, asked TEXT NOT NULL,
                               model TEXT NOT NULL, judged_at INTEGER NOT NULL);
  `,
  `
  -- Plans and decisions Jev spotted and the owner's AI extracted; when_ts: when it happens (plans), NULL if unstated.
  CREATE TABLE plans (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
                      when_ts INTEGER, who_json TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX plans_when ON plans(when_ts);
  `,
  `
  -- The owner's tags. jev_question: JSON (question and the condition that applies the tag); NULL = manual only.
  -- auto: its question rides the per-message Jev request for new messages.
  CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, jev_question TEXT,
                     auto INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  -- Message tag states: jev stores matching answers; manual records owner additions; removed prevents Jev reapplication.
  --
  CREATE TABLE message_tags (message_id TEXT NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                             state TEXT NOT NULL, value REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (message_id, tag_id));
  CREATE INDEX message_tags_tag ON message_tags(tag_id, state);
  `,
  `
  -- Summary runs: what started them (manual | catch-up | digest), how points are grouped, and the "For you" list (JSON).
  ALTER TABLE summaries ADD COLUMN run_trigger TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE summaries ADD COLUMN grouping TEXT NOT NULL DEFAULT 'overall';
  ALTER TABLE summaries ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]';
  -- The regex builder's rule a topic's pattern was made from (JSON PatternSpec); NULL when typed.
  ALTER TABLE topics ADD COLUMN pattern_spec TEXT;
  `,
  `
  -- What Jev cost per local day (YYYY-MM-DD). priced_questions: questions in requests that reported a price (the rate's
  -- denominator); unpriced_requests: answered without a price, so not in usd.
  CREATE TABLE jev_spend (day TEXT PRIMARY KEY, requests INTEGER NOT NULL, priced_questions INTEGER NOT NULL, usd REAL NOT NULL,
                          unpriced_requests INTEGER NOT NULL);
  `,
  RETIRED,
  RETIRED,
  `
  -- Jev tokens as System One reports them. tokenless_requests: answered without token counts (all rows before this).
  ALTER TABLE jev_spend ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jev_spend ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jev_spend ADD COLUMN tokenless_requests INTEGER NOT NULL DEFAULT 0;
  UPDATE jev_spend SET tokenless_requests = requests;
  `,
  `
  -- Audio transcripts survive file pruning. seq is the FTS rowid; priority distinguishes owner requests; segments store timed text; state tracks processing.
  --
  --
  CREATE TABLE transcripts (seq INTEGER PRIMARY KEY, attachment_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL,
                            state TEXT NOT NULL, priority INTEGER NOT NULL, requested_at INTEGER NOT NULL,
                            text TEXT, segments TEXT, language TEXT, model TEXT, error TEXT, done_at INTEGER);
  CREATE INDEX transcripts_message ON transcripts(message_id);
  CREATE INDEX transcripts_queued ON transcripts(priority, requested_at) WHERE state = 'queued';
  CREATE VIRTUAL TABLE fts_transcripts USING fts5(text, content='transcripts', content_rowid='seq');
  CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts WHEN new.text IS NOT NULL BEGIN
    INSERT INTO fts_transcripts(rowid, text) VALUES (new.seq, new.text);
  END;
  CREATE TRIGGER transcripts_ad AFTER DELETE ON transcripts WHEN old.text IS NOT NULL BEGIN
    INSERT INTO fts_transcripts(fts_transcripts, rowid, text) VALUES ('delete', old.seq, old.text);
  END;
  CREATE TRIGGER transcripts_au AFTER UPDATE OF text ON transcripts BEGIN
    INSERT INTO fts_transcripts(fts_transcripts, rowid, text) SELECT 'delete', old.seq, old.text WHERE old.text IS NOT NULL;
    INSERT INTO fts_transcripts(rowid, text) SELECT new.seq, new.text WHERE new.text IS NOT NULL;
  END;
  `,
  `
  -- Caches server nicknames, with NULL meaning none. Seeds uncompressed archived member payloads; live messages and member events maintain them.
  --
  --
  CREATE TABLE members (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, nick TEXT, updated_at INTEGER NOT NULL,
                        PRIMARY KEY (guild_id, user_id));
  INSERT INTO members (guild_id, user_id, nick, updated_at)
    SELECT c.guild_id, m.author_id, json_extract(CASE WHEN typeof(m.raw_json) = 'text' THEN m.raw_json END, '$.member.nick'), MAX(m.ts)
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE json_extract(CASE WHEN typeof(m.raw_json) = 'text' THEN m.raw_json END, '$.member') IS NOT NULL AND c.guild_id IS NOT NULL
    GROUP BY c.guild_id, m.author_id;
  `,
  `
  -- 0: the topic never raises a desktop notification (its alerts are still recorded).
  ALTER TABLE topics ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- JSON ContentKind[]: the topic covers only messages carrying any of these. NULL = any message.
  ALTER TABLE topics ADD COLUMN contains TEXT;
  `,
  RETIRED,
  RETIRED,
  RETIRED,
  `
  -- Privacy mode (settings key 'privacyMode', JSON true while on) hides marked servers and channels from every view.
  ALTER TABLE guilds ADD COLUMN hide_in_privacy INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN hide_in_privacy INTEGER NOT NULL DEFAULT 0;
  -- Channels hidden right now: marked, or under a marked channel (threads, forum posts) or server. Empty while off.
  CREATE VIEW hidden_channels AS
    SELECT c.id FROM channels c LEFT JOIN channels p ON p.id = c.parent_id LEFT JOIN guilds g ON g.id = c.guild_id
    WHERE (SELECT value FROM settings WHERE key = 'privacyMode') = 'true'
      AND (c.hide_in_privacy = 1 OR p.hide_in_privacy = 1 OR g.hide_in_privacy = 1);
  -- Snowflakes a visible message may not contain (a <#id> mention or a discord.com/channels link): hidden channels and servers.
  CREATE VIEW hidden_ids AS
    SELECT id FROM hidden_channels
    UNION ALL SELECT id FROM guilds WHERE hide_in_privacy = 1 AND (SELECT value FROM settings WHERE key = 'privacyMode') = 'true';
  `,
];

/** Ordered migrations; index + 1 = schema version. Append new ones to LATER_MIGRATIONS. */
export const MIGRATIONS: readonly Migration[] = [...EARLY_MIGRATIONS, ...LATER_MIGRATIONS];

/** Runs one step on `db` (the caller owns the transaction). */
export function applyMigration(db: Db, step: Migration): void {
  if (typeof step === 'string') db.exec(step);
  else step(db);
}
