// Typed payload metadata decoded outside persistent SQL views, including compressed archive payloads.
import { CONTENT_KINDS, type ContentKind } from '@shared/messageContent';
import { rawJsonText, type Db } from '../db';
import { contentColumnsSql, kindsOfRow } from '../queries/messageContent';
import { REPLY_MESSAGE_TYPE } from '../queries/messageExtras';

/** Payload metadata for a selected archived message; no privacy filtering is added to the selected ids. */
export interface ArchivePayload {
  embedsJson: string | null;
  mentionsJson: string | null;
  bot: number | null;
  flags: number | null;
  isReply: number | null;
  replyToId: string | null;
  audioSeconds: number | null;
  kinds: ReadonlySet<ContentKind>;
}

/** A scoped context reader; callers select ids through their archive or visible-table contract. */
export type ArchivePayloadReader = (ids: readonly string[]) => Map<string, ArchivePayload>;

/** Reads payload metadata without requiring an application-defined SQLite function on the connection. */
export function archivePayloads(db: Db, ids: readonly string[]): Map<string, ArchivePayload> {
  const out = new Map<string, ArchivePayload>();
  if (!ids.length) return out;
  const rows = db.prepare('SELECT id, raw_json FROM messages WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as { id: string; raw_json: string | Buffer | null }[];
  const decoded = rows.map((row) => ({ id: row.id, raw: rawJsonText(row.raw_json) }));
  const details = db.prepare(`WITH payloads AS (
      SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.raw') AS raw FROM json_each(?)
    ) SELECT m.id, json_extract(p.raw, '$.embeds') AS embedsJson,
    json_extract(p.raw, '$.mentions') AS mentionsJson, json_extract(p.raw, '$.author.bot') AS bot,
    json_extract(p.raw, '$.flags') AS flags, json_extract(p.raw, '$.type') = ${REPLY_MESSAGE_TYPE} AS isReply,
    json_extract(p.raw, '$.message_reference.message_id') AS replyToId,
    (SELECT SUM(json_extract(a.value, '$.duration_secs')) FROM json_each(p.raw, '$.attachments') a) AS audioSeconds,
    ${contentColumnsSql(CONTENT_KINDS).replaceAll('msg_json(m.raw_json)', 'p.raw')}
    FROM messages m JOIN payloads p ON p.id = m.id`);
  for (const result of details.all(JSON.stringify(decoded)) as (Omit<ArchivePayload, 'kinds'> & { id: string } & Record<string, unknown>)[]) {
    const { embedsJson, mentionsJson, bot, flags, isReply, replyToId, audioSeconds } = result;
    out.set(result.id, { embedsJson, mentionsJson, bot, flags, isReply, replyToId, audioSeconds, kinds: kindsOfRow(result, CONTENT_KINDS) });
  }
  return out;
}
