import { getSetting, parseRawJson, setSetting, type Db } from '../db';
import { deriveMessage, type DerivableMessage } from './deriveMessage';

/** Bump when attachment/link derivation rules change; stored messages are re-derived on startup. */
const DERIVE_VERSION = 8; // Derivation versions: 2 emoji; 3 canonical URLs; 4 X posts; 5 unfurled bot links/Reddit posts; 6 fixer mirrors; 7 attachment metadata/removals; 8 flags.
const DERIVE_VERSION_KEY = 'archive.deriveVersion';
/** Rows per read during re-derivation; bounds memory for large archives. */
const REDERIVE_BATCH_ROWS = 1000;

/** Re-derives stored payloads after version changes or missing derivation. Returns processed messages; rebuilt runs transactionally after links rebuild. */
export function rederiveIfStale(db: Db, rebuilt: () => void): number {
  const stored = getSetting(db, DERIVE_VERSION_KEY);
  if (stored === DERIVE_VERSION) return 0;
  // Batched reads: better-sqlite3 forbids writing on a connection while an iterator is open.
  const batch = db.prepare('SELECT seq, author_id, raw_json FROM messages WHERE raw_json IS NOT NULL AND seq > ? ORDER BY seq LIMIT ?');
  let n = 0;
  db.transaction(() => {
    // Links are purely derived (no user state): rebuild them so rule changes can't leave stale rows.
    db.exec('DELETE FROM message_links; DELETE FROM links;');
    for (let after = 0; ;) {
      const rows = batch.all(after, REDERIVE_BATCH_ROWS) as { seq: number; author_id: string; raw_json: string | Buffer }[];
      if (!rows.length) break;
      for (const r of rows) deriveMessage(db, parseRawJson<DerivableMessage>(r.raw_json)!, r.author_id);
      n += rows.length;
      after = rows.at(-1)!.seq;
    }
    rebuilt();
    setSetting(db, DERIVE_VERSION_KEY, DERIVE_VERSION);
  })();
  return n;
}
