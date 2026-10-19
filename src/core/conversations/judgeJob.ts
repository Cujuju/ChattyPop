// Asks Jev about the chooser's unsure links from the last 30 days, a batch at a time, then relinks them with the answers.
import type { DecisionProvider } from '../ai/decisions';
import type { Db } from '../db';
import { chooserWeights, storedChooser, type StoredChooser } from './fit';
import { LINKER_VERSION } from './job';
import { calibrateJudge, currentJudge, judgeMessage } from './judge';
import { CANDIDATE_MAX } from './linker';
import { readHost } from '../reads/archiveReads';
import { JUDGE_RETRY_MS, type PendingJudgment as Pending } from './unjudged';
import { channelReach, contextInputs, messageInput, queueConversationLinks } from './store';
export { unjudged, JUDGE_LOOKBACK_MS, JUDGE_RETRY_MS } from './unjudged';

/** Messages asked about per step: five rounds of Jev's four requests in flight, so a switch-off stops within a few seconds. */
export const JUDGE_BATCH = 20;

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
      const batch = await readHost<Pending>(db, { kind: 'unjudged', now: Date.now(), limit: JUDGE_BATCH }, abort.signal, 'background');
      const current = this.jev();
      if (abort.signal.aborted || db !== this.db() || !current || current.model !== jev.model) return;
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
    if (db.prepare('SELECT 1 FROM conversation_marks WHERE message_id = ?').get(p.id)) return false;
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
