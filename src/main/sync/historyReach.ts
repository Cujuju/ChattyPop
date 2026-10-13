// History asked for beyond a channel's depth setting, kept only while someone waits for it.
import type { SyncState } from '@shared/contract';
import { snowflakeToMs } from '@shared/discord';

/** How a wait ended: the stored history reaches the time, sync stopped short of it (paused, not archived, quitting), or a request failed. */
export type HistoryOutcome = 'reached' | 'stopped' | 'failed';
export interface HistoryResult {
  channelId: string;
  outcome: HistoryOutcome;
  /** Why it failed. */
  message?: string;
}

/** Whether a stored range stops after `sinceMs` with more to fetch. */
export const shortOf = (state: SyncState, sinceMs: number): boolean =>
  !state.backfillComplete && (state.oldestId === null || snowflakeToMs(state.oldestId) > sinceMs);

/** Worse outcomes win when a channel and its threads end differently. */
const SEVERITY: Record<HistoryOutcome, number> = { reached: 0, stopped: 1, failed: 2 };

interface Reach {
  root: string;
  sinceMs: number;
  /** The channel and the threads fetched for it whose sync hasn't ended. */
  waiting: Set<string>;
  result: HistoryResult;
  promise: Promise<HistoryResult>;
  resolve(result: HistoryResult): void;
}

/** One wait per channel, covering the threads sync fetches for it. Nothing here outlives the wait or changes a setting. */
export class HistoryReaches {
  private readonly byChannel = new Map<string, Reach>();

  /** Waits for `channelId`'s history back to `sinceMs`; a second ask while one waits deepens it and shares its end. */
  ask(channelId: string, sinceMs: number): Promise<HistoryResult> {
    const waiting = this.byChannel.get(channelId);
    if (waiting) {
      waiting.sinceMs = Math.min(waiting.sinceMs, sinceMs);
      return waiting.promise;
    }
    let resolve!: Reach['resolve'];
    const promise = new Promise<HistoryResult>((r) => (resolve = r));
    this.byChannel.set(channelId, { root: channelId, sinceMs, waiting: new Set([channelId]), result: { channelId, outcome: 'reached' }, promise, resolve });
    return promise;
  }

  /** The time `channelId` is fetched back to beyond its setting; undefined when nobody waits. */
  sinceMs(channelId: string): number | undefined {
    return this.byChannel.get(channelId)?.sinceMs;
  }

  /** `threadIds` are fetched for `channelId`'s wait, which ends once their syncs have too. */
  include(channelId: string, threadIds: readonly string[]): void {
    const reach = this.byChannel.get(channelId);
    if (!reach) return;
    for (const id of threadIds) {
      if (this.byChannel.has(id)) continue;
      reach.waiting.add(id);
      this.byChannel.set(id, reach);
    }
  }

  /** `channelId`'s sync ended with `outcome`; its wait ends once nothing of it is left. */
  done(channelId: string, outcome: HistoryOutcome, message?: string): void {
    const reach = this.byChannel.get(channelId);
    if (!reach) return;
    if (SEVERITY[outcome] > SEVERITY[reach.result.outcome]) reach.result = { channelId: reach.root, outcome, ...(message ? { message } : {}) };
    reach.waiting.delete(channelId);
    this.byChannel.delete(channelId);
    if (!reach.waiting.size) reach.resolve(reach.result);
  }

  /** Ends every wait as stopped (the queue was dropped). */
  stopAll(): void {
    for (const id of [...this.byChannel.keys()]) this.done(id, 'stopped');
  }
}
