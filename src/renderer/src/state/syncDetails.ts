import { api } from '@/api';
import { createStore } from 'solid-js/store';
import { snowflakeToMs } from '@shared/discord';
import { MS_PER_DAY } from '@shared/units';
import { onAppEvent } from './events';
import { archiveSettings } from './preferences';

/** Backfill reports a page every few seconds; re-read a channel's reach at most this often. */
const REFRESH_MS = 5000;
/** An ETA needs this much progress to be more than noise. */
const MIN_PROGRESS_FOR_ETA = 0.02;

export interface BackfillProgress {
  /** Oldest message time reached so far. */
  reachedTs: number;
  /** 0..1 of the backfill window (Settings → Archive → backfill days) covered. */
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
  const windowMs = archiveSettings().backfillDays * MS_PER_DAY;
  const reachedTs = snowflakeToMs(state.oldestId);
  const fraction = state.backfillComplete ? 1 : Math.min(1, Math.max(0, (now - reachedTs) / windowMs));
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
