import { api } from '@/api';
import { createStore } from 'solid-js/store';
import { snowflakeToMs } from '@shared/discord';
import { PACE_TIMING, backfillCutoffMs, resolveBackfillCutoffMs, type ArchiveSettings, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { backfillFraction, estimateBackfillPages } from '@shared/backfillProgress';
import { onAppEvent } from './events';
import { archiveSettings } from './preferences';
import { channelById } from './directory';

/** Backfill reports a page every few seconds; re-read a channel's reach at most this often. */
const REFRESH_MS = 5000;
/** An ETA needs this much progress to be more than noise. */
const MIN_PROGRESS_FOR_ETA = 0.02;

export interface BackfillProgress {
  /** Oldest message time reached so far. */
  reachedTs: number;
  /** 0..1 of the channel's requested history window covered. */
  fraction: number;
  /** Estimated ms remaining, from the pace since this session first saw the channel backfilling; null until meaningful. */
  etaMs: number | null;
}

const [progress, setProgress] = createStore<Record<string, BackfillProgress>>({});
export { progress as backfillProgress };

/** First observation per channel this session: when and how far, for the rate. */
const started = new Map<string, { at: number; fraction: number }>();
const lastRead = new Map<string, number>();

async function refresh(channelId: string): Promise<void> {
  const state = await api.core.syncState(channelId);
  if (!state.oldestId) return;
  const now = Date.now();
  // A thread the directory doesn't list yet is measured against the default depth until it does.
  const cutoffMs = resolveBackfillCutoffMs(archiveSettings(), channelId, now, channelById(channelId));
  const reachedTs = snowflakeToMs(state.oldestId);
  const fraction = state.backfillComplete ? 1 : backfillFraction(now, cutoffMs, snowflakeToMs(channelId), reachedTs);
  const first = started.get(channelId) ?? { at: now, fraction };
  started.set(channelId, first);
  const gained = fraction - first.fraction;
  const etaMs = gained >= MIN_PROGRESS_FOR_ETA ? ((now - first.at) / gained) * (1 - fraction) : null;
  setProgress(channelId, { reachedTs, fraction, etaMs });
}

onAppEvent('sync-progress', (e) => {
  if (e.phase !== 'backfill') return;
  const now = Date.now();
  if (now - (lastRead.get(e.channelId) ?? 0) < REFRESH_MS) return;
  lastRead.set(e.channelId, now);
  void refresh(e.channelId);
});

/** What bringing channels to a depth costs: history requests in all, and the channels too little is stored of to tell. */
export interface BackfillCost {
  pages: number;
  unknown: number;
  /** Time the requests take at the owner's sync pace, ms. */
  durationMs: number;
}

const timeOf = (id: string | null): number | null => (id === null ? null : snowflakeToMs(id));

/** The cost of fetching each of `channelIds` back to `history` at `pace`. Every input is a parameter, so a caller's source tracks them. Threads aren't counted. */
export async function backfillCost(channelIds: readonly string[], history: ChannelBackfillHistory, pace: ArchiveSettings['syncPace']): Promise<BackfillCost> {
  const now = Date.now();
  const cutoffMs = backfillCutoffMs(history, now);
  const cost: BackfillCost = { pages: 0, unknown: 0, durationMs: 0 };
  for (const state of await Promise.all(channelIds.map((id) => api.core.syncState(id)))) {
    const stored = { count: state.count, oldestMs: timeOf(state.oldestId), newestMs: timeOf(state.newestId), backfillComplete: state.backfillComplete };
    const pages = estimateBackfillPages(stored, cutoffMs, snowflakeToMs(state.channelId));
    if (pages === null) cost.unknown++;
    else cost.pages += pages;
  }
  cost.durationMs = cost.pages * PACE_TIMING[pace].apiMs;
  return cost;
}
