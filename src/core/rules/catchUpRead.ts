import type { Db } from '../db';
import type { TextMessage } from '../arrival';
import { TEXT_MESSAGE_COLUMNS } from '../queries/messageText';

/** Four judgment batches per helper snapshot, bounding IPC and text hydration. */
export const CATCH_UP_PAGE_ROWS = 100;
/** Matches the judge's maximum batch size; live rule callbacks yield between batches. */
export const CATCH_UP_TURN_ROWS = 25;
export interface CatchUpCursor { ts: number; seq: number; throughSeq: number }
export interface CatchUpPage {
  messages: (TextMessage & { seq: number })[];
  judged: string[];
  throughSeq: number;
}

/** Internal rule processing retains its existing full-archive scope; no rows leave Core for a window. */
export function catchUpPage(db: Db, since: number, cursor?: CatchUpCursor): CatchUpPage {
  const throughSeq = cursor?.throughSeq ?? db.prepare('SELECT COALESCE(MAX(seq), 0) FROM messages').pluck().get() as number;
  const messages = db.prepare(`SELECT m.seq, ${TEXT_MESSAGE_COLUMNS} FROM messages m
    WHERE m.ts >= @since AND (m.ts, m.seq) > (@ts, @seq) AND m.seq <= @throughSeq
    ORDER BY m.ts, m.seq LIMIT @limit`).all({ since, ts: cursor?.ts ?? since, seq: cursor?.seq ?? 0, throughSeq, limit: CATCH_UP_PAGE_ROWS }) as CatchUpPage['messages'];
  const judged = db.prepare(`SELECT message_id AS m, subject AS s FROM jev_judgments
    WHERE message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(messages.map((m) => m.id))) as { m: string; s: string }[];
  return { messages, judged: judged.map((r) => `${r.m}|${r.s}`), throughSeq };
}
