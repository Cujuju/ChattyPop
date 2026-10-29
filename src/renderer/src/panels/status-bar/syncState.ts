// The capture item's dot and tooltip: live capture, then each archived channel that isn't up to date.
import { archivedChannels, channelLabel, syncProgress } from '@/state/directory';
import { ageLabel, captureOn } from '@/state/statusBar';
import { backfillProgress } from '@/state/syncDetails';
import { onServerScreen } from '@/state/ui';
import { percentText, shortDate } from '@/ui/format';

type Phase = NonNullable<(typeof syncProgress)[string]>['phase'];

const PHASE_LABEL: Record<Phase, string> = {
  'catch-up': 'Catching up',
  backfill: 'Backfilling',
  reverify: 'Re-checking recent edits',
  idle: 'Up to date',
  paused: 'Sync paused (Settings)',
  error: 'Error',
};
/** Phases that are fetching archive messages now. */
const UPDATING: ReadonlySet<Phase> = new Set(['catch-up', 'backfill', 'reverify']);

/** The dot: unknown until capture is known; off when signed out; error when a channel failed; syncing while any channel updates; else on. */
export type CaptureDot = 'unknown' | 'off' | 'error' | 'syncing' | 'on';

/** Archived channels and threads not up to date, with their progress. Reactive. */
const busyRows = () =>
  archivedChannels({ threads: true })
    .map((c) => ({ c, p: syncProgress[c.id] }))
    .filter((r): r is { c: typeof r.c; p: NonNullable<typeof r.p> } => !!r.p && r.p.phase !== 'idle');

export function captureDot(): CaptureDot {
  const on = captureOn();
  if (on === null) return 'unknown';
  if (!on) return 'off';
  const rows = busyRows();
  if (rows.some((r) => r.p.phase === 'error')) return 'error';
  return rows.some((r) => UPDATING.has(r.p.phase)) ? 'syncing' : 'on';
}

/** Backfill detail: share of the backfill window reached, the date reached, and an ETA once the pace is known. */
function backfillDetail(channelId: string, fetched: number): string {
  const b = backfillProgress[channelId];
  if (!b) return `${fetched} msgs`;
  const eta = b.etaMs !== null ? ` · ~${ageLabel(b.etaMs)} left` : '';
  return `${percentText(b.fraction)} · back to ${shortDate(b.reachedTs)}${eta}`;
}

/** The capture item's tooltip: capture state, then each channel's phase and progress, or that all are up to date. Reactive. */
export function captureTitle(): string {
  const capture =
    captureOn() === false ? `Live capture off: sign in to Discord ${onServerScreen ? 'in the Live view' : 'from the Chat panel'}` : 'Live capture on';
  const rows = busyRows();
  if (!rows.length) return `${capture}\nAll archived channels up to date`;
  const lines = rows.map(({ c, p }) => {
    const detail = p.phase === 'error' ? p.message : p.phase === 'backfill' ? backfillDetail(c.id, p.fetched) : `${p.fetched} msgs`;
    return `${channelLabel(c)}: ${PHASE_LABEL[p.phase]}${detail ? ` · ${detail}` : ''}`;
  });
  return [capture, ...lines].join('\n');
}
