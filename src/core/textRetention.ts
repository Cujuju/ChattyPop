// Archive text retention with active plugin coverage.
import { TEXT_COVERED_SQL, loadTextCoverage } from './textCoverage';
import type { ArchiveSettings, TextTier } from '@shared/settings';
import { BYTES_PER_GB, MS_PER_DAY } from '@shared/units';
import { textTierOverrides } from './channelPolicy';
import { compact, compressRawJson, type Db } from './db';
import { NOTABLE_QUERY, NOTABLE_SUBJECT } from './jev/notable';
import { storedStrengthSql } from './jev/queries';
import { SerialLoop } from './serialLoop';

/** Rows per write transaction; each batch yields so sync and UI requests are served in between. */
const BATCH_ROWS = 500;
/** Rewrite the file (VACUUM) once this share of it is slack: shrinking rows frees space inside pages, not whole pages. */
const VACUUM_SLACK_FRACTION = 0.25;

export interface TextRetentionResult {
  compressed: number;
  pruned: number;
  /** Bytes still over the database cap after everything the tier allows; 0 when under it or no cap is set. */
  overCapBytes: number;
}

const yieldToQueue = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Bytes of live data (excluding free space inside and between pages). */
const liveBytes = (db: Db): number => (db.prepare('SELECT COALESCE(SUM(pgsize - unused), 0) AS n FROM dbstat').get() as { n: number }).n;
const fileBytes = (db: Db): number => (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);

/** Tracks live bytes as batches shrink rows, so the cap check needn't rescan the database. */
interface Budget {
  live: number;
  cap: number;
}
const over = (b: Budget) => (): boolean => b.live > b.cap;
const always = (): boolean => true;

/** Channel ids a pass may touch (JSON array for json_each), or null for every channel. */
type Scope = string | null;
const IN_SCOPE = '(@scope IS NULL OR m.channel_id IN (SELECT value FROM json_each(@scope)))';

/**
 * With Settings → Jev → keep important, a message whose notable strength (0–1, see storedStrengthSql) is at least
 * this is never compressed or removed. Below the catch-up badges' default cut (0.7): wrongly dropping text costs more
 * than keeping some that wasn't needed.
 */
export const IMPORTANT_AT = 0.5;

/** How a pass picks messages: `keep` excludes ones it must leave alone; `order` says which go first; `params` they use. */
interface Rules {
  keep: string;
  order: string;
  params: Record<string, unknown>;
}
const OLDEST_FIRST: Rules = { keep: '1', order: 'm.ts', params: {} };
/**
 * Important messages stay; the least notable go first, never-judged ones just before important ones, oldest first
 * within. Built per pass: the notable query (Settings → Jev → Queries) may have changed type.
 */
function keepImportantRules(): Rules {
  const s = storedStrengthSql(NOTABLE_QUERY, 'jj', 'notable_');
  const notable = `(SELECT ${s.sql} FROM jev_judgments jj WHERE jj.message_id = m.id AND jj.subject = '${NOTABLE_SUBJECT}')`;
  return { keep: `COALESCE(${notable}, 0) < @importantAt`, order: `COALESCE(${notable}, @importantAt), m.ts`, params: { ...s.params, importantAt: IMPORTANT_AT } };
}

/** Runs retention one pass at a time; a pass requested mid-run happens right after it, so no request is lost. */
export class TextRetentionRunner {
  /** Bytes over the database cap after the last pass (Settings shows it). */
  overCapBytes = 0;
  private readonly loop: SerialLoop;

  constructor(pass: () => Promise<TextRetentionResult>, changed: () => void) {
    this.loop = new SerialLoop(async () => {
      const r = await pass();
      this.overCapBytes = r.overCapBytes;
      if (r.compressed || r.pruned) changed();
    });
  }

  /** Resolves at once when a pass is running (another follows it); rejects when this call's pass fails. */
  request(): Promise<void> {
    return this.loop.kick();
  }
}


/**
 * Applies Settings → Archive text retention: messages older than the tier age are compressed (and, for summary-only,
 * pruned once covered by an active provider). Over the database cap, the oldest are compressed, then pruned if the tier allows,
 * regardless of age. Uncovered text is never removed. Oldest first; freed pages go back to the disk.
 */
export async function applyTextRetention(db: Db, s: ArchiveSettings, now: number, keepImportant = false): Promise<TextRetentionResult> {
  const rules = keepImportant ? keepImportantRules() : OLDEST_FIRST;
  const result: TextRetentionResult = { compressed: 0, pruned: 0, overCapBytes: 0 };
  const tierBefore = now - s.textTierAfterDays * MS_PER_DAY;
  const b: Budget = { live: liveBytes(db), cap: s.textCapGb === null ? Infinity : s.textCapGb * BYTES_PER_GB };
  // A channel's own tier (channel list → right-click) overrides the global one; threads follow their parent.
  const overrides = textTierOverrides(db);
  const ids = (db.prepare('SELECT id FROM channels').all() as { id: string }[]).map((r) => r.id);
  const scope = (tiers: TextTier[]): Scope => JSON.stringify(ids.filter((id) => tiers.includes(overrides.get(id) ?? s.textTier)));
  const compressing = scope(['compressed', 'summary-only']);
  const pruning = scope(['summary-only']);

  result.compressed += await compressOldest(db, tierBefore, compressing, rules, b, always);
  result.pruned += await pruneOldest(db, tierBefore, pruning, rules, b, always);
  // Over the cap: compression is lossless, so any channel; removing text only where the tier allows it.
  result.compressed += await compressOldest(db, Infinity, null, rules, b, over(b));
  result.pruned += await pruneOldest(db, Infinity, pruning, rules, b, over(b));
  if (result.compressed || result.pruned) {
    const live = liveBytes(db);
    if (fileBytes(db) - live > fileBytes(db) * VACUUM_SLACK_FRACTION) compact(db);
    else db.pragma('incremental_vacuum');
    b.live = live;
  }
  result.overCapBytes = Math.max(0, b.live - b.cap);
  return result;
}

/** Compresses plain payloads of messages older than `before`, oldest first, while `more()` holds. */
async function compressOldest(db: Db, before: number, scope: Scope, rules: Rules, b: Budget, more: () => boolean): Promise<number> {
  const pick = db.prepare(
    `SELECT seq, raw_json AS raw FROM messages m WHERE typeof(raw_json) = 'text' AND ts < @before AND ${IN_SCOPE} AND ${rules.keep} ORDER BY ${rules.order} LIMIT @limit`,
  );
  const write = db.prepare('UPDATE messages SET raw_json = ? WHERE seq = ?');
  let n = 0;
  while (more()) {
    const rows = pick.all({ before, scope, limit: BATCH_ROWS, ...rules.params }) as { seq: number; raw: string }[];
    if (!rows.length) break;
    db.transaction(() =>
      rows.forEach((r) => {
        const packed = compressRawJson(r.raw);
        write.run(packed, r.seq);
        b.live -= Buffer.byteLength(r.raw) - packed.length;
      }),
    )();
    n += rows.length;
    await yieldToQueue();
  }
  return n;
}

/** Removes text, payload and edit history of covered messages older than `before`, oldest first, while `more()` holds. */
async function pruneOldest(db: Db, before: number, scope: Scope, rules: Rules, b: Budget, more: () => boolean): Promise<number> {
  const prune = db.prepare("UPDATE messages SET content = '', raw_json = NULL, pruned_at = ? WHERE id = ?");
  const history = db.prepare('DELETE FROM message_revisions WHERE message_id = ?');
  let n = 0;
  // Loaded before each pick (and first to create its temp table): coverage an owner dropped never removes text.
  loadTextCoverage(db);
  const pick = db.prepare(
    `SELECT m.id, length(CAST(m.content AS BLOB)) + COALESCE(length(m.raw_json), 0) AS bytes FROM messages m
     WHERE m.pruned_at IS NULL AND m.ts < @before AND ${IN_SCOPE} AND ${TEXT_COVERED_SQL} AND ${rules.keep} ORDER BY ${rules.order} LIMIT @limit`,
  );
  while (more()) {
    const rows = pick.all({ before, scope, limit: BATCH_ROWS, ...rules.params }) as { id: string; bytes: number }[];
    if (!rows.length) break;
    const at = Date.now();
    db.transaction(() =>
      rows.forEach((r) => {
        prune.run(at, r.id);
        history.run(r.id);
        b.live -= r.bytes;
      }),
    )();
    n += rows.length;
    await yieldToQueue();
    loadTextCoverage(db);
  }
  return n;
}
