import { Show } from 'solid-js';
import type { StorageMovePhase } from '@shared/contract';
import { BYTES_PER_MB } from '@shared/units';
import { deletePreviousArchive, moveArchive, storageInfo, storageMove } from '@/state/storage';
import { inCompanion } from '@/state/ui';
import { Card, Note, Row } from './SettingsLayout';
import styles from './Settings.module.css';

const PERCENT = 100;

const PHASE_LABEL: Record<StorageMovePhase, string> = {
  stopping: 'Stopping sync and closing the database…',
  copying: 'Copying',
  verifying: 'Verifying the copy…',
  restarting: 'Done. Restarting…',
  error: 'Move failed',
};

/** Settings → Archive: move the archive to another folder, then delete the old copy. */
export function StorageLocation() {
  const busy = () => {
    const p = storageMove()?.phase;
    return p !== undefined && p !== 'error';
  };
  const progress = (): string => {
    const m = storageMove();
    if (!m) return '';
    if (m.phase !== 'copying') return m.message ? `${PHASE_LABEL[m.phase]}: ${m.message}` : PHASE_LABEL[m.phase];
    const pct = m.totalBytes ? Math.floor((m.doneBytes / m.totalBytes) * PERCENT) : 0;
    return `${PHASE_LABEL.copying} ${(m.doneBytes / BYTES_PER_MB).toFixed(0)} of ${(m.totalBytes / BYTES_PER_MB).toFixed(0)} MB (${pct}%)`;
  };
  return (
    <Card title="Location">
      <Row
        label={storageInfo()?.dir ?? '…'}
        hint="Moving copies the database and media to the new folder, checks the copy, then restarts there. The original stays until you delete it."
        control={
          <Show when={!inCompanion}>
            <button type="button" class={`cp-button ${styles.button}`} disabled={busy()} onClick={() => void moveArchive()}>
              Move archive…
            </button>
          </Show>
        }
      >
        <Show when={storageMove()}>
          <Note kind={storageMove()?.phase === 'error' ? 'error' : 'status'}>{progress()}</Note>
        </Show>
      </Row>
      <Show when={storageInfo()?.previousDir}>
        {(dir) => (
          <Row
            label="Previous copy"
            hint={dir()}
            control={
              <Show when={!inCompanion}>
                <button type="button" class={`cp-button ${styles.button}`} onClick={() => void deletePreviousArchive()}>
                  Delete previous copy…
                </button>
              </Show>
            }
          />
        )}
      </Show>
      <Show when={inCompanion}>
        <Note>Move the archive or delete its previous copy on your PC.</Note>
      </Show>
    </Card>
  );
}
