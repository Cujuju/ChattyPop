// The two DM dialogs (docs/dms.md §4.4): renaming a group, and confirming leaving one, with Discord's Leave quietly. Each
// closes, its name cleared, once its conversation leaves the list (dmActions.ts).
import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import { GROUP_DM_NAME_MAX } from '@shared/dms';
import { closeDmDialog, dmDialog, dmDialogChannel, leaveDm, renameDm } from '@/state/dmActions';
import { createAction } from '@/ui/action';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './DmDialog.module.css';

export function DmDialog() {
  const action = createAction();
  const [name, setName] = createSignal('');
  const [quietly, setQuietly] = createSignal(false);
  const kind = () => dmDialog()?.kind ?? null;
  createEffect(
    on(dmDialog, (d) => {
      action.cancel();
      setName(d?.kind === 'rename' ? (untrack(dmDialogChannel)?.name ?? '') : '');
      setQuietly(false);
    }),
  );
  /** Runs the write; the dialog closes once Discord took it, and shows its reason otherwise. */
  const submit = async (write: () => Promise<void>): Promise<void> => {
    if (action.busy()) return;
    if (await action.run(() => write().then(() => true))) closeDmDialog();
  };
  const error = action.error;

  return (
    <>
      <FloatingWindow id="dm-rename" open={kind() === 'rename'} class={`${chrome.dialog} ${styles.window}`} aria-label="Rename group" onClose={closeDmDialog}>
        <WindowHeader title="Rename group" classes={chrome} closeLabel="Cancel" onClose={closeDmDialog} />
        <form
          class={`${chrome.body} ${styles.form}`}
          onSubmit={(e) => {
            e.preventDefault();
            const c = dmDialogChannel();
            if (c && name().trim()) void submit(() => renameDm(c, name()));
          }}
        >
          <label class="cp-field">
            <span class="cp-label">Group name</span>
            <input type="text" value={name()} maxLength={GROUP_DM_NAME_MAX} disabled={action.busy()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
          </label>
          <Show when={error()}>
            {(text) => (
              <p class="cp-error" role="alert">
                {text()}
              </p>
            )}
          </Show>
          <div class="cp-actions">
            <button type="button" class="cp-button" onClick={closeDmDialog}>
              Cancel
            </button>
            <button type="submit" class="cp-primary" disabled={action.busy() || !name().trim() || !dmDialogChannel()}>
              {action.busy() ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </FloatingWindow>
      <FloatingWindow id="dm-leave" open={kind() === 'leave'} class={`${chrome.dialog} ${styles.window}`} aria-label="Leave group" onClose={closeDmDialog}>
        <WindowHeader title={`Leave ${dmDialogChannel()?.name ?? 'group'}`} classes={chrome} closeLabel="Cancel" onClose={closeDmDialog} />
        <form
          class={`${chrome.body} ${styles.form}`}
          onSubmit={(e) => {
            e.preventDefault();
            const c = dmDialogChannel();
            if (c) void submit(() => leaveDm(c, quietly()));
          }}
        >
          <p class="cp-hint">You won't get its messages unless someone adds you back. What's archived stays.</p>
          <label class="cp-check">
            <input type="checkbox" checked={quietly()} disabled={action.busy()} onChange={(e) => setQuietly(e.currentTarget.checked)} />
            Leave quietly: members aren't told you left
          </label>
          <Show when={error()}>
            {(text) => (
              <p class="cp-error" role="alert">
                {text()}
              </p>
            )}
          </Show>
          <div class="cp-actions">
            <button type="button" class="cp-button" onClick={closeDmDialog}>
              Cancel
            </button>
            <button type="submit" class="cp-danger" disabled={action.busy() || !dmDialogChannel()}>
              {action.busy() ? 'Leaving…' : 'Leave group'}
            </button>
          </div>
        </form>
      </FloatingWindow>
    </>
  );
}
