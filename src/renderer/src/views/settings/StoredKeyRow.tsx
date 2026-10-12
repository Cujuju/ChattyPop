import { Show, createSignal } from 'solid-js';
import { confirmDialog } from '@/state/dialogs';
import { createAction } from '@/ui/action';
import { ErrorNote, Row, settingsControl as c } from './SettingsLayout';
import styles from './Settings.module.css';

export interface StoredKeyRowProps {
  label: string;
  fieldId: string;
  placeholder: string;
  hint: string | null;
  storedHint?: string;
  /** Empty-state wording when a connection needs instructions beyond the provider payment hint. */
  emptyHint?: string;
  onSave(key: string): Promise<void>;
  onRemove(): Promise<void>;
  removeMessage: string;
}

/** Checks and stores a pasted key, or confirms removal of the stored one. Only its hint is rendered. */
export function StoredKeyRow(props: StoredKeyRowProps) {
  const [pasted, setPasted] = createSignal('');
  const action = createAction();
  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({ title: 'Remove key', message: props.removeMessage, confirmLabel: 'Remove', danger: true });
    if (ok) await action.run(props.onRemove);
  };
  return (
    <>
      <Show when={props.hint} fallback={
        <form onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await props.onSave(pasted());
            setPasted('');
          });
        }}>
          <Row label={props.label} for={props.fieldId} hint={props.emptyHint ?? 'Pays with this key instead of your sign-in.'} control={
            <div class={c.buttons}>
              <input id={props.fieldId} type="password" autocomplete="off" placeholder={props.placeholder} class={c.select}
                value={pasted()} onInput={(e) => setPasted(e.currentTarget.value)} />
              <button type="submit" class={`cp-button ${styles.button}`} disabled={action.busy() || !pasted().trim()}>
                {action.busy() ? 'Checking…' : 'Save key'}
              </button>
            </div>
          } />
        </form>
      }>
        {(hint) => <Row label={props.label} hint={props.storedHint ?? `Stored, ending ${hint()}.`} control={
          <button type="button" class={`cp-button ${styles.button}`} disabled={action.busy()} onClick={() => void remove()}>Remove key</button>
        } />}
      </Show>
      <ErrorNote error={action.error()} />
    </>
  );
}
