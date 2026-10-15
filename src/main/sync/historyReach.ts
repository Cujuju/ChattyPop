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

/**
 * Whether a stored range may still miss messages at or after `sinceMs`. A range ending exactly at `sinceMs` is short: other
 * messages of that millisecond may sort before it.
 */
export const shortOf = (state: SyncState, sinceMs: number): boolean =>
  !state.backfillComplete && (state.oldestId === null || snowflakeToMs(state.oldestId) >= sinceMs);

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

/** One wait per asked channel, covering the threads sync fetches for it. Nothing here outlives the wait or changes a setting. */
export class HistoryReaches {
  /** Each channel's waits: its own, and its parent's when fetched for that. */
  private readonly byChannel = new Map<string, Reach[]>();

  private own(channelId: string): Reach | undefined {
    return this.byChannel.get(channelId)?.find((r) => r.root === channelId);
  }

  private add(channelId: string, reach: Reach): void {
    reach.waiting.add(channelId);
    this.byChannel.set(channelId, [...(this.byChannel.get(channelId) ?? []), reach]);
  }

  private worsen(reach: Reach, outcome: HistoryOutcome, message?: string): void {
    if (SEVERITY[outcome] > SEVERITY[reach.result.outcome]) reach.result = { channelId: reach.root, outcome, ...(message ? { message } : {}) };
  }

  /** Waits for `channelId`'s history back to `sinceMs`; a second ask while one waits deepens it and shares its end. */
  ask(channelId: string, sinceMs: number): Promise<HistoryResult> {
    const waiting = this.own(channelId);
    if (waiting) {
      waiting.sinceMs = Math.min(waiting.sinceMs, sinceMs);
      return waiting.promise;
    }
    let resolve!: Reach['resolve'];
    const promise = new Promise<HistoryResult>((r) => (resolve = r));
    this.add(channelId, { root: channelId, sinceMs, waiting: new Set(), result: { channelId, outcome: 'reached' }, promise, resolve });
    return promise;
  }

  /** The time `channelId` is fetched back to beyond its setting (the deepest of its waits); undefined when nobody waits. */
  sinceMs(channelId: string): number | undefined {
    const reaches = this.byChannel.get(channelId);
    return reaches ? Math.min(...reaches.map((r) => r.sinceMs)) : undefined;
  }

  /** `threadIds` are fetched for `channelId`'s wait, which ends once their syncs have too. */
  include(channelId: string, threadIds: readonly string[]): void {
    const reach = this.own(channelId);
    if (!reach) return;
    for (const id of threadIds) if (!reach.waiting.has(id)) this.add(id, reach);
  }

  /** Something of `channelId`'s waits went wrong without ending its part (its threads couldn't be listed). */
  note(channelId: string, outcome: HistoryOutcome, message?: string): void {
    for (const reach of this.byChannel.get(channelId) ?? []) this.worsen(reach, outcome, message);
  }

  /** `channelId`'s sync ended with `outcome`; each of its waits ends once nothing of it is left. */
  done(channelId: string, outcome: HistoryOutcome, message?: string): void {
    const reaches = this.byChannel.get(channelId);
    if (!reaches) return;
    this.byChannel.delete(channelId);
    for (const reach of reaches) {
      this.worsen(reach, outcome, message);
      reach.waiting.delete(channelId);
      if (!reach.waiting.size) reach.resolve(reach.result);
    }
  }

  /** Ends every wait as stopped (the queue was dropped). */
  stopAll(): void {
    for (const id of [...this.byChannel.keys()]) this.done(id, 'stopped');
  }
}
