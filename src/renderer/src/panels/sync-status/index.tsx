import { For, Show } from 'solid-js';
import { archivedChannels, channelLabel, syncProgress } from '@/state/directory';
import { sidebarCollapsed } from '@/state/layout';
import { ageLabel, captureOn } from '@/state/statusBar';
import { backfillProgress } from '@/state/syncDetails';
import { percentText, shortDate } from '@/ui/format';
import styles from './SyncStatus.module.css';

const PHASE_LABEL = {
  'catch-up': 'Catching up',
  backfill: 'Backfilling',
  reverify: 'Re-checking recent edits',
  idle: 'Up to date',
  paused: 'Sync paused (Settings)',
  error: 'Error',
} as const;

/** Backfill detail: share of the backfill window reached, the date reached, and an ETA once the pace is known. */
function backfillDetail(channelId: string, fetched: number): string {
  const b = backfillProgress[channelId];
  if (!b) return `${fetched} msgs`;
  const eta = b.etaMs !== null ? ` · ~${ageLabel(b.etaMs)} left` : '';
  return `${percentText(b.fraction)} · back to ${shortDate(b.reachedTs)}${eta}`;
}

/** Per-channel sync activity for opted-in channels. */
export function SyncStatusPanel() {
  const rows = () =>
    archivedChannels({ threads: true })
      .map((c) => ({ c, p: syncProgress[c.id] }))
      .filter((r) => r.p && r.p.phase !== 'idle');

  /** Collapsed sidebar tooltip summarizes full-panel status. */
  const summary = (): string =>
    rows().length
      ? rows()
          .map((r) => `${channelLabel(r.c)}: ${PHASE_LABEL[r.p!.phase]}`)
          .join('\n')
      : 'All archived channels up to date';
  return (
    <Show
      when={!sidebarCollapsed()}
      fallback={
        <section class={styles.dotOnly} aria-label={`Sync status: ${summary()}`} title={summary()}>
          <span class={styles.dot} data-busy={rows().length > 0} data-error={rows().some((r) => r.p!.phase === 'error')} />
        </section>
      }
    >
      <section class={styles.root} aria-label="Sync status">
        <h2 class={styles.title}>Sync</h2>
        <p class={styles.idle} data-capture={captureOn() === false ? 'off' : 'on'}>
          {captureOn() === false ? 'Live capture off: sign in to Discord in the Live view' : 'Live capture on'}
        </p>
        <Show when={rows().length > 0} fallback={<p class={styles.idle}>All archived channels up to date</p>}>
          <For each={rows()}>
            {(r) => (
              <div class={styles.row} data-phase={r.p!.phase}>
                <span class={styles.channel}>{channelLabel(r.c)}</span>
                <span class={styles.phase}>{PHASE_LABEL[r.p!.phase]}</span>
                <span class={styles.fetched}>{r.p!.phase === 'error' ? r.p!.message : r.p!.phase === 'backfill' ? backfillDetail(r.c.id, r.p!.fetched) : `${r.p!.fetched} msgs`}</span>
              </div>
            )}
          </For>
        </Show>
      </section>
    </Show>
  );
}
