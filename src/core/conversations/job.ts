// Links queued message ranges in the background, a batch per step, yielding to other core work between batches.
import { getSetting, setSetting, type Db } from '../db';
import { chooserWeights, FIT_MIN_REPLIES, fittedWeights, REFIT_GROWTH, replySamples, saveChooser, storedChooser } from './fit';
import { CANDIDATE_MAX, linkMessages } from './linker';
import { channelReach, contextInputs, linkInputs, queueAllConversationLinks, storedReplyCount, threadStart, writeLinks } from './store';

/** Bump when linking rules or the chooser's features change: every channel is relinked and the chooser refitted on the next start. */
export const LINKER_VERSION = 2;
export const LINKER_VERSION_KEY = 'conversations.linkerVersion';
/** Messages linked per synchronous step, matching the archive's other background scans. */
export const LINK_BATCH = 500;

interface Queued { channelId: string; fromTs: number; untilTs: number }

const yieldToQueue = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class ConversationLinkJob {
  private scheduled = false;
  private current: Promise<void> | null = null;
  /** The chooser's refit is checked once per run of the app, before its first linking; a failed fit waits for the next run. */
  private fitChecked = false;

  /** `db` is null while the archive is closed or moving. */
  constructor(private readonly db: () => Db | null) {}

  /** Queues every channel when the rules changed since the last run, then links. */
  start(): void {
    const db = this.db();
    if (!db) return;
    if (getSetting(db, LINKER_VERSION_KEY) !== LINKER_VERSION) {
      db.transaction(() => {
        queueAllConversationLinks(db);
        setSetting(db, LINKER_VERSION_KEY, LINKER_VERSION);
      })();
    }
    this.kick();
  }

  /** Links queued ranges soon; safe inside an ingest transaction (work starts after it). */
  kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.run();
    });
  }

  /** Links until the queue is empty; concurrent calls share one run. A failure (the archive closing) ends it until the next kick. */
  run(): Promise<void> {
    this.current ??= this.drain()
      .catch((err) => console.error('[conversations] linking stopped', err))
      .finally(() => { this.current = null; });
    return this.current;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const db = this.db();
      if (!db) return;
      if (!this.fitChecked) {
        this.fitChecked = true;
        await this.refitIfDue(db);
      }
      const queued = db.prepare('SELECT channel_id AS channelId, from_ts AS fromTs, until_ts AS untilTs FROM conversation_link_queue LIMIT 1')
        .get() as Queued | undefined;
      if (!queued) return;
      await this.linkRange(db, queued);
      await yieldToQueue();
    }
  }

  /** Fits the chooser when it has none for this version, or the stored replies doubled since; a new fit relinks everything. */
  private async refitIfDue(db: Db): Promise<void> {
    const stored = storedChooser(db, LINKER_VERSION);
    const replies = storedReplyCount(db);
    if (replies < FIT_MIN_REPLIES || (stored && replies < stored.replies * REFIT_GROWTH)) return;
    const weights = [...fittedWeights(await replySamples(db))];
    if (this.db() !== db) return;
    db.transaction(() => {
      saveChooser(db, { weights, replies, linkerVersion: LINKER_VERSION });
      queueAllConversationLinks(db);
    })();
  }

  /** Links one range; stops early when ingest widened it meanwhile (the next pass takes the new range). */
  private async linkRange(db: Db, q: Queued): Promise<void> {
    const reachMs = channelReach(db, q.channelId);
    const weights = chooserWeights(db, LINKER_VERSION);
    const thread = threadStart(db, q.channelId);
    const endTs = q.untilTs + reachMs;
    let from = q.fromTs;
    let cursor = { ts: q.fromTs, id: '' };
    let context = contextInputs(db, q.channelId, cursor, reachMs, CANDIDATE_MAX);
    for (;;) {
      if (this.db() !== db) return;
      const batch = linkInputs(db, q.channelId, cursor, endTs, LINK_BATCH);
      const last = batch.at(-1);
      const done = batch.length < LINK_BATCH;
      const kept = db.transaction(() => {
        if (batch.length) writeLinks(db, q.channelId, linkMessages(context, batch, { reachMs, weights, ...(thread ? { thread } : {}) }), new Map(batch.map((m) => [m.id, m.ts])));
        // Compare-and-set: ingest may have widened the range since it was read.
        return done
          ? db.prepare('DELETE FROM conversation_link_queue WHERE channel_id = ? AND from_ts = ? AND until_ts = ?').run(q.channelId, from, q.untilTs).changes
          : db.prepare('UPDATE conversation_link_queue SET from_ts = ? WHERE channel_id = ? AND from_ts = ?').run(last!.ts, q.channelId, from).changes;
      })();
      if (done || !kept) return;
      from = last!.ts;
      cursor = { ts: last!.ts, id: last!.id };
      context = [...context, ...batch].slice(-CANDIDATE_MAX);
      await yieldToQueue();
    }
  }
}
