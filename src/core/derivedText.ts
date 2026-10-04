// Derived text (docs/research.md §7.1 → Wave 2 design): text a plugin makes for a message (a transcript). The host
// keeps and indexes it (derived_texts, fts_derived_texts); message text, content and search read it after the content.
// Link text: a plugin's text for a link (a fetched post), kept in link_texts and read as what messages link to.
import type { Db } from './db';
import { textedLinkCount } from './queries/messageText';

/**
 * Stores or replaces (by `source`) one derived text of a message. `record`: the plugin's own writes (its job marked
 * done), in the same transaction, so a crash can't leave one without the other.
 */
export function storeDerivedText(db: Db, messageId: string, source: string, order: number, text: string, record?: () => void, part: string | null = null): void {
  // The content reads as order 0 (MESSAGE_TEXT_SQL).
  if (!Number.isInteger(order) || order <= 0) throw new Error(`A derived text's order must be a positive integer, not ${order}.`);
  db.transaction(() => {
    record?.();
    db.prepare(
      `INSERT INTO derived_texts (message_id, source, ord, text, part) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET message_id = excluded.message_id, ord = excluded.ord, text = excluded.text, part = excluded.part`,
    ).run(messageId, source, order, text, part);
  })();
}

/**
 * Names the part of `source`-prefixed texts stored before parts existed (`parts`: its key → part key). Only texts with
 * no part change; nothing is re-read or re-matched, so old messages fire no rules again.
 */
export function tagDerivedParts(db: Db, sourcePrefix: string, parts: ReadonlyMap<string, string>): void {
  const tag = db.prepare('UPDATE derived_texts SET part = ? WHERE source = ? AND part IS NULL');
  db.transaction(() => {
    for (const [key, part] of parts) tag.run(part, `${sourcePrefix}${key}`);
  })();
}

/** A plugin's derived text of a message part, as another plugin reads it. */
export interface PartText {
  messageId: string;
  pluginId: string;
  /** messageParts partKey. */
  part: string;
  text: string;
}

/** The derived texts of these messages that name their part, in each message's order; empty texts are left out. */
export function partTexts(db: Db, messageIds: readonly string[]): PartText[] {
  if (!messageIds.length) return [];
  const rows = db
    .prepare(
      `SELECT message_id AS messageId, source, part, text FROM derived_texts
       WHERE message_id IN (SELECT value FROM json_each(?)) AND part IS NOT NULL AND text != '' ORDER BY message_id, ord`,
    )
    .all(JSON.stringify(messageIds)) as { messageId: string; source: string; part: string; text: string }[];
  // source: '<plugin id>:<its key>'; plugin ids have no ':' (checkBundled).
  return rows.map((r) => ({ messageId: r.messageId, pluginId: r.source.slice(0, r.source.indexOf(':')), part: r.part, text: r.text }));
}

/**
 * Stores or replaces (by `source`) a plugin's text for link `url`, with `record` in the same transaction. Returns the
 * messages whose links gained text by it (none had text for that link before), to be judged again.
 */
export function storeLinkText(db: Db, url: string, source: string, text: string, record?: () => void): string[] {
  return db.transaction(() => {
    const ids = db
      .prepare('SELECT DISTINCT ml.message_id FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE l.url = ?')
      .pluck()
      .all(url) as string[];
    const before = new Map(ids.map((id) => [id, textedLinkCount(db, id)]));
    record?.();
    db.prepare(
      `INSERT INTO link_texts (url, source, text) VALUES (?, ?, ?)
       ON CONFLICT(url, source) DO UPDATE SET text = excluded.text`,
    ).run(url, source, text);
    return ids.filter((id) => textedLinkCount(db, id) > (before.get(id) ?? 0));
  })();
}
