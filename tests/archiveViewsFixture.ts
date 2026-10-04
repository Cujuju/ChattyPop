// Shared archive-view fixtures and the documented column contract.
import type { Db } from '../src/core/db';

/** Every public column, selected explicitly in the contract test. */
export const VIEW_COLUMNS: Record<string, string> = {
  messages: 'id, seq, channel_id, author_id, ts, edited_ts, deleted_at, pruned_at, content, raw_json, arrived_via, text, linked, author_name, author_plain_name, transcript, username, guild_id',
  channels: 'id, guild_id, name, kind, parent_id, opted_in, is_thread',
  guilds: 'id, name, icon',
  users: 'id, username, global_name, avatar, display_name',
  attachments: 'id, message_id, channel_id, filename, content_type, size, width, height, url, sha256, status, error, stored_bytes',
  rules: 'id, name, managed_key',
  links: 'id, url, platform, title, description, thumbnail_url, site, first_message_id, first_channel_id, first_author_id, first_ts, author_name',
  message_links: 'message_id, link_id',
  search: 'seq, query, rank',
  names: 'channel_id, user_id, name',
};

/** Hidden channels, inherited privacy, hidden-id references, missing metadata and retained orphan references. */
export function seedArchiveViews(db: Db): void {
  db.exec(`
    INSERT INTO guilds (id, name, hide_in_privacy) VALUES ('g-open', 'Open', 0), ('g-secret', 'Secret', 1);
    INSERT INTO channels (id, guild_id, name, kind, parent_id, hide_in_privacy) VALUES
      ('c-open', 'g-open', 'Open', 0, NULL, 0), ('c-hide', 'g-open', 'Hidden', 0, NULL, 1),
      ('c-thread', 'g-open', 'Thread', 11, 'c-hide', 0), ('c-secret', 'g-secret', 'Secret', 0, NULL, 0);
    INSERT INTO users (id, username, global_name) VALUES ('u1', 'alice', 'Alice'), ('u2', 'bob', NULL);
    INSERT INTO members (guild_id, user_id, nick, updated_at) VALUES ('g-open', 'u1', 'Ally', 1), ('g-secret', 'u1', 'Secret Ally', 1);
    INSERT INTO messages (id, channel_id, author_id, ts, content) VALUES
      ('m-open', 'c-open', 'u1', 1, 'hello open'), ('m-hide', 'c-hide', 'u1', 2, 'hello hidden'),
      ('m-thread', 'c-thread', 'u1', 3, 'hello thread'), ('m-secret', 'c-secret', 'u1', 4, 'hello server'),
      ('m-ref-channel', 'c-open', 'u1', 5, 'hello <#c-hide>'),
      ('m-ref-guild', 'c-open', 'u1', 6, 'hello https://discord.com/channels/g-secret/other/1'),
      ('m-missing', 'c-missing', 'u-missing', 7, 'hello missing metadata');
    INSERT INTO attachments (id, message_id, channel_id, filename, url)
      SELECT id, id, channel_id, 'audio.ogg', 'https://example.com/audio' FROM messages;
    INSERT INTO attachments (id, message_id, channel_id, filename, url) VALUES
      ('a-orphan', 'gone', 'c-open', 'orphan', 'https://example.com/orphan'),
      ('a-hidden-orphan', 'gone-hidden', 'c-hide', 'orphan', 'https://example.com/orphan');
    INSERT INTO rules (id, name, spec, position, armed_at, created_at, builtin) VALUES (1, 'Rule', '{}', 0, 1, 1, 'alerts.aimed_at_me');
    INSERT INTO links (id, url, platform, first_message_id, first_channel_id, first_author_id, first_ts) VALUES
      (1, 'https://example.com/open', 'other', 'm-open', 'c-open', 'u1', 1),
      (2, 'https://example.com/hidden', 'other', 'm-hide', 'c-hide', 'u1', 2),
      (3, 'https://example.com/reference', 'other', 'm-ref-channel', 'c-open', 'u1', 3),
      (4, 'https://discord.com/channels/g-secret/other/1', 'other', 'm-open', 'c-open', 'u1', 4),
      (5, 'https://example.com/orphan', 'other', 'gone', 'c-open', 'u1', 5);
    INSERT INTO message_links (message_id, link_id) VALUES ('m-open', 1), ('m-hide', 1), ('m-hide', 2), ('m-ref-channel', 3), ('gone', 5);
    INSERT INTO derived_texts (message_id, source, ord, text) VALUES ('m-open', 'probe:second', 2, 'second'), ('m-open', 'probe:first', 1, 'first');
    INSERT INTO link_texts (url, source, text) VALUES ('https://example.com/open', 'probe', 'linked text');
  `);
}

/** Privacy-neutral users and rules have only one view name. */
export const archiveViewNames = (suffix: string): string[] => ['users', 'rules'].includes(suffix) ? [`archive_${suffix}`] : [`archive_${suffix}`, `archive_all_${suffix}`];
