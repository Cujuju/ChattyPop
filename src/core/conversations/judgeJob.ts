// Asks Jev about the chooser's unsure links from the last 30 days, a batch at a time, then relinks them with the answers.
import { MS_PER_DAY } from '@shared/units';
import type { DecisionProvider } from '../ai/decisions';
import { localOnlyChannelIds } from '../channelPolicy';
import type { Db } from '../db';
import { chooserWeights, storedChooser, type StoredChooser } from './fit';
import { LINKER_VERSION } from './job';
import { calibrateJudge, currentJudge, judgeMessage } from './judge';
import { CANDIDATE_MAX, JUDGE_BELOW, LINK_KIND } from './linker';
import { channelReach, contextInputs, messageInput, queueConversationLinks } from './store';

/** The owner's choice (#303): new messages and the last 30 days, never the whole archive. */
export const JUDGE_LOOKBACK_MS = 30 * MS_PER_DAY;
/** A failed or stale judgment is asked again after this, so a message that keeps failing costs one request a day. */
export const JUDGE_RETRY_MS = MS_PER_DAY;
/** Messages asked about per step: five rounds of Jev's four requests in flight, so a switch-off stops within a few seconds. */
export const JUDGE_BATCH = 20;

interface Pending { id: string; channelId: string; ts: number }

/** The newest unsure links that need a judgment: none yet, or a failed one due again. Marked messages are the owner's. */
export function unjudged(db: Db, now: number, limit: number): Pending[] {
  return db.prepare(`SELECT l.message_id AS id, l.channel_id AS channelId, l.ts FROM conversation_links l
    LEFT JOIN conversation_judgments j ON j.message_id = l.message_id
    WHERE l.kind = '${LINK_KIND.inferred}' AND l.confidence < ? AND l.ts >= ?
      AND (j.message_id IS NULL OR j.failed_at < ?)
      AND l.channel_id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM conversation_marks k WHERE k.message_id = l.message_id)
    ORDER BY l.ts DESC LIMIT ?`).all(JUDGE_BELOW, now - JUDGE_LOOKBACK_MS, now - JUDGE_RETRY_MS, JSON.stringify([...localOnlyChannelIds(db)]), limit) as Pending[];
}

/** A fit's identity for the calibration latch: a refit with the same weights still moves its held-out boundary. */
const fitKey = (fit: StoredChooser | undefined): string => JSON.stringify([fit?.weights ?? null, fit?.sampleFromTs ?? null]);

const yieldToQueue = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class ConversationJudgeJob {
  private scheduled = false;
  private current: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** The chooser fit whose calibration found too few cases this run of the app: not retried until the fit changes (a refit). */
  private uncalibrated: string | null = null;
  /** Calibration got too few answers (Jev failing): not retried before this, so an outage costs one attempt a day. */
  private calibrateAfter = 0;

  /**
   * @param db null while the archive is closed or moving
   * @param jev null while Settings → Jev → Link unsure conversations is off or no Jev route is set up
   * @param relinked judgments were stored and their messages queued: the link job should run
   */
  constructor(
    private readonly db: () => Db | null,
    private readonly jev: () => DecisionProvider | null,
    private readonly relinked: () => void,
  ) {}

  /** Judges soon: at startup, when the switch or route changes, and after linking wrote new links. */
  kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.run();
    });
  }

  /** Cancels requests in flight and waiting (the switch turned off, the archive closing); turning it on again retries calibration. */
  stop(): void {
    this.abort?.abort();
    this.uncalibrated = null;
    this.calibrateAfter = 0;
  }

  run(): Promise<void> {
    this.current ??= this.drain()
      .catch((err: unknown) => {
        if (!this.abort?.signal.aborted) console.error('[conversations] judging stopped', err);
      })
      .finally(() => { this.current = null; });
    return this.current;
  }

  private async drain(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    for (;;) {
      const db = this.db();
      const jev = this.jev();
      if (!db || !jev || abort.signal.aborted) return;
      const chooser = chooserWeights(db, LINKER_VERSION);
      const judge = currentJudge(db, chooser);
      if (!judge || judge.model !== jev.model) {
        const fit = storedChooser(db, LINKER_VERSION);
        if (this.uncalibrated === fitKey(fit) || Date.now() < this.calibrateAfter) return;
        const calibration = await calibrateJudge(db, jev, fit, abort.signal);
        if (calibration === 'too-few') {
          this.uncalibrated = fitKey(fit);
          console.warn('[conversations] too few held-out replies to calibrate the judge');
          return;
        }
        if (calibration === 'unanswered') {
          this.calibrateAfter = Date.now() + JUDGE_RETRY_MS;
          console.warn('[conversations] Jev answered too few calibration requests; trying again tomorrow');
          return;
        }
        this.relinked();
        continue;
      }
      const batch = unjudged(db, Date.now(), JUDGE_BATCH);
      if (!batch.length) return;
      const judged = await Promise.all(batch.map((p) => this.judgeOne(db, jev, p, abort.signal)));
      this.relinked();
      // Every request failed (Jev down, a rejected key): wait for the next kick instead of walking the backlog failing.
      if (!judged.some(Boolean)) return;
      await yieldToQueue();
    }
  }

  /** Whether Jev answered. */
  private async judgeOne(db: Db, jev: DecisionProvider, p: Pending, signal: AbortSignal): Promise<boolean> {
    const m = messageInput(db, p.id);
    if (!m) return false;
    const candidates = contextInputs(db, p.channelId, m, channelReach(db, p.channelId), CANDIDATE_MAX);
    try {
      const answered = await judgeMessage(db, jev, m, p.channelId, candidates, signal);
      if (answered) queueConversationLinks(db, p.channelId, m.ts);
      return answered !== null;
    } catch (err) {
      signal.throwIfAborted();
      console.warn('[conversations] judging a message failed', err);
      return false;
    }
  }
}
