// Stopped DMs show read-only retained history; never-archived DMs offer archiving. Phone, requests and left groups omit archive actions.
import { Show, createSignal } from 'solid-js';
import { openLive } from '@/state/archive';
import { setChannelOptIn } from '@/state/directory';
import { isClosedGroup, isReadOnlyDm, type DmChannel } from '@/state/dmRules';
import { inCompanion } from '@/state/ui';
import { errorText } from '@/ui/format';
import styles from './Archive.module.css';

/** Turns archiving on for `c`; returns a click handler and whether it is in flight. Failures are shown, not swallowed. */
function createArchiveAction(c: () => DmChannel): { busy: () => boolean; run: () => void } {
  const [busy, setBusy] = createSignal(false);
  const run = (): void => {
    setBusy(true);
    setChannelOptIn(c().id, true)
      .catch((err: unknown) => window.alert(`Couldn't archive this conversation: ${errorText(err)}`))
      .finally(() => setBusy(false));
  };
  return { busy, run };
}

/** Over the log of a DM whose archiving stopped: its kept history reads as usual, and Resume archives it again. */
export function NotArchivingBar(props: { channel: DmChannel }) {
  const action = createArchiveAction(() => props.channel);
  return (
    <div class={styles.dmBar} role="status">
      <span>Not archiving: new messages aren't stored</span>
      <Show when={!inCompanion && !isReadOnlyDm(props.channel)}>
        <button type="button" class={styles.dmBarAction} disabled={action.busy()} onClick={action.run}>
          Resume
        </button>
      </Show>
    </div>
  );
}

/** In place of an empty log: a DM with no history stored, to archive or to read in the live client. */
export function NotArchived(props: { channel: DmChannel }) {
  const action = createArchiveAction(() => props.channel);
  const hint = (): string =>
    isClosedGroup(props.channel)
      ? "You left this group, so its history can't be read any more."
      : props.channel.dm.request
        ? 'A message request is read-only here: accept it in Discord to archive it.'
        : inCompanion
          ? 'Archive it from your PC to keep its history here.'
          : 'Archive it to keep its history, search it, and use it in rules and summaries. You can also read it in Discord without storing anything.';
  return (
    <div class={styles.dmEmpty}>
      <h3 class={styles.dmEmptyTitle}>This conversation isn't archived</h3>
      <p class={`cp-hint ${styles.dmEmptyText}`}>{hint()}</p>
      <Show when={!inCompanion}>
        <div class={styles.dmEmptyActions}>
          <Show when={!isReadOnlyDm(props.channel)}>
            <button type="button" class="cp-primary" disabled={action.busy()} onClick={action.run}>
              Archive this conversation
            </button>
          </Show>
          <button type="button" class="cp-button" onClick={() => openLive(props.channel)}>
            Open in Discord
          </button>
        </div>
      </Show>
    </div>
  );
}
