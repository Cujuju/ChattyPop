import { For, Show, createEffect, createSignal } from 'solid-js';
import { REMINDER_PRESETS, localReminderTime, localReminderValue, reminderPreset } from '@shared/savedMessages';
import { closeReminder, reminderDraft, reminderPresetLabel, saveReminder, savedBusy } from '@/state/savedMessages';
import { ModalDialog } from '@/ui/ModalDialog';
import { errorText } from '@/ui/format';
import { failureNotice } from '@/state/dialogs';
import styles from './ReminderDialog.module.css';

export function ReminderDialog() {
  const [value, setValue] = createSignal(''), [error, setError] = createSignal('');
  createEffect(() => { const draft = reminderDraft(); setValue(localReminderValue(draft?.dueAt ? new Date(draft.dueAt) : reminderPreset('1h'))); setError(''); });
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const draft = reminderDraft();
    if (!draft || savedBusy()) return;
    setError('');
    try { await saveReminder(draft, localReminderTime(value())); if (reminderDraft() === draft) closeReminder(); }
    catch (e) { if (reminderDraft() === draft) setError(errorText(e)); else failureNotice("Couldn't save the reminder")(e); }
  };
  return <ModalDialog id="message-reminder" open={reminderDraft() !== null} title="Remind me" onClose={closeReminder}>
    <form class={styles.form} onSubmit={(e) => void submit(e)}>
      <p class={styles.summary}>{reminderDraft()?.summary || 'Saved message'}</p>
      <div class={styles.presets}><For each={REMINDER_PRESETS}>{(preset) => <button type="button" disabled={savedBusy()} onClick={() => setValue(localReminderValue(reminderPreset(preset)))}>{reminderPresetLabel(preset)}</button>}</For></div>
      <label class="cp-field">Local date and time<input type="datetime-local" value={value()} onInput={(e) => setValue(e.currentTarget.value)} required disabled={savedBusy()} /></label>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
      <div class="cp-actions"><button type="button" onClick={closeReminder}>Cancel</button><button type="submit" class="cp-primary" disabled={savedBusy()}>{savedBusy() ? 'Saving…' : 'Save reminder'}</button></div>
    </form>
  </ModalDialog>;
}
