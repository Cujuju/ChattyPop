// The directory's `dm` block (docs/dms.md §3.4): a DM's people, read and mute state, and preview.
import type { DirectoryChannel } from '@shared/contract';
import type { Db } from '../db';
import { PRIVATE_KINDS_SQL } from '../privateChannels';
import { visibleMessageSql } from './privacy';
import { snippet } from './snippet';

type Dm = NonNullable<DirectoryChannel['dm']>;
type Person = Dm['recipients'][number];

/**
 * SQL true when channel alias `c` is no DM, or a DM of `@self`. An unclaimed DM (no account) is listed for none, and
 * with `@self` unknown ('') no DM is.
 */
export const ownPrivateChannelSql = (c: string): string => `(${c}.kind NOT IN (${PRIVATE_KINDS_SQL}) OR ${c}.account_id = @self)`;

/** A person's shown name: display name, else username. */
const NAME_SQL = 'COALESCE(u.global_name, u.username)';

/**
 * The `dm` block of each private channel in `ids`. Its recipients are its roster alone (membership), empty while the
 * roster is unknown; a face for display is the channel's `peer` or `icon`. The preview is the newest visible,
 * undeleted message.
 */
export function dmBlocks(db: Db, ids: string[]): Map<string, Dm> {
  if (!ids.length) return new Map();
  const params = { ids: JSON.stringify(ids) };
  const rows = db
    .prepare(
      `SELECT c.id, c.owner_id AS ownerId, c.last_message_id AS lastMessageId, c.closed_at IS NOT NULL AS closed, c.recipients IS NOT NULL AS rosterKnown,
              (c.is_message_request = 1 OR c.is_spam = 1) AS request,
              c.opted_in AS optedIn, EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id) AS hasHistory,
              r.ack_id AS ackId, r.mute_ends_ms AS muteEndsMs,
              (SELECT m.id FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND ${visibleMessageSql('m')}
               ORDER BY m.ts DESC, length(m.id) DESC, m.id DESC LIMIT 1) AS previewId
       FROM channels c LEFT JOIN read_states r ON r.channel_id = c.id
       WHERE c.id IN (SELECT value FROM json_each(@ids)) AND c.kind IN (${PRIVATE_KINDS_SQL})`,
    )
    .all(params) as {
    id: string;
    ownerId: string | null;
    lastMessageId: string | null;
    closed: number;
    rosterKnown: number;
    request: number;
    optedIn: number;
    hasHistory: number;
    ackId: string | null;
    muteEndsMs: number | null;
    previewId: string | null;
  }[];
  const roster = new Map<string, Person[]>();
  const members = db
    .prepare(
      `SELECT c.id AS channelId, u.id, ${NAME_SQL} AS name, u.avatar FROM channels c, json_each(c.recipients) r JOIN users u ON u.id = r.value
       WHERE c.id IN (SELECT value FROM json_each(@ids)) AND c.recipients IS NOT NULL ORDER BY ${NAME_SQL} COLLATE NOCASE, u.id`,
    )
    .all(params) as (Person & { channelId: string })[];
  for (const { channelId, ...p } of members) roster.set(channelId, [...(roster.get(channelId) ?? []), p]);

  const previews = new Map(
    (db
      .prepare(`SELECT m.id, m.content, COALESCE(${NAME_SQL}, '') AS authorName FROM messages m LEFT JOIN users u ON u.id = m.author_id
                WHERE m.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(rows.flatMap((r) => (r.previewId ? [r.previewId] : [])))) as { id: string; content: string; authorName: string }[]).map((p) => [p.id, p]),
  );
  return new Map(
    rows.map((r) => {
      const preview = r.previewId ? previews.get(r.previewId) : undefined;
      const dm: Dm = {
        recipients: roster.get(r.id) ?? [],
        rosterKnown: r.rosterKnown === 1,
        ownerId: r.ownerId,
        lastMessageId: r.lastMessageId,
        ackId: r.ackId,
        muteEndsMs: r.muteEndsMs,
        closed: r.closed === 1,
        request: r.request === 1,
        archived: r.optedIn === 1 ? 'on' : r.hasHistory === 1 ? 'stopped' : 'never',
        // Retention leaves a pruned message's text empty; the preview shows what the archive keeps.
        preview: preview ? { authorName: preview.authorName, text: snippet(preview.content, null) } : null,
      };
      return [r.id, dm];
    }),
  );
}
