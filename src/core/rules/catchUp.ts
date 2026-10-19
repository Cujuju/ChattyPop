import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { Db } from '../db';
import type { TextMessage } from '../arrival';
import { archiveReadFence, readHost } from '../reads/archiveReads';
import { textMessage } from '../queries/messageText';
import { MEANING_LOOKBACK_MS } from '../jev/messageJudge';
import { CATCH_UP_PAGE_ROWS, CATCH_UP_TURN_ROWS, type CatchUpCursor, type CatchUpPage } from './catchUpRead';

/** Coalesces startup/rule edits; heavy text reads run in a background helper and callbacks run in bounded turns. */
export class RuleCatchUp {
  private pending: Promise<void> | undefined;
  private requested = false;
  private throughSeq = 0;
  private since = 0;
  private readonly controller = new AbortController();

  constructor(private readonly db: Db, private readonly process: (messages: TextMessage[], judged: Set<string>) => void) {}

  request(rerun = false): Promise<void> {
    if (this.controller.signal.aborted || !this.db.open) return Promise.resolve();
    if (this.pending && !rerun) return this.pending;
    // The original synchronous pass included only messages already stored when requested.
    this.throughSeq = this.db.prepare('SELECT COALESCE(MAX(seq), 0) FROM messages').pluck().get() as number;
    this.since = Date.now() - MEANING_LOOKBACK_MS;
    this.requested = true;
    if (!this.pending) this.pending = this.drain().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  dispose(): void { this.requested = false; this.controller.abort(new Error('Rule catch-up stopped')); }

  private async drain(): Promise<void> {
    await yieldTurn();
    while (this.requested && this.db.open && !this.controller.signal.aborted) {
      this.requested = false;
      if (!this.throughSeq) continue;
      try { await this.scan(this.since, this.throughSeq); }
      catch (error) { if (!this.requested) throw error; }
    }
  }

  private async scan(since: number, throughSeq: number): Promise<void> {
    const fence = archiveReadFence(this.db);
    let cursor: CatchUpCursor = { ts: since, seq: 0, throughSeq };
    for (;;) {
      const [page] = await readHost<CatchUpPage>(this.db, { kind: 'ruleCatchUp', since, cursor }, this.controller.signal);
      if (!page?.messages.length) break;
      const judged = new Set(page.judged);
      for (let at = 0; at < page.messages.length; at += CATCH_UP_TURN_ROWS) {
        await yieldTurn();
        this.controller.signal.throwIfAborted();
        fence();
        // Edits/deletions while the snapshot waited are handled by their own arrival, never by stale text.
        const current = page.messages.slice(at, at + CATCH_UP_TURN_ROWS).filter((m) => {
          const live = textMessage(this.db, m.id);
          return live && live.content === m.content && live.linked === m.linked && live.ts === m.ts;
        });
        this.process(current, judged);
      }
      const last = page.messages.at(-1)!;
      cursor = { ts: last.ts, seq: last.seq, throughSeq: page.throughSeq };
      if (page.messages.length < CATCH_UP_PAGE_ROWS) break;
    }
  }
}
