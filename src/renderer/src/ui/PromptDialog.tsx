// The shown confirmation or notice (state/dialogs) as the app's modal dialog.
import { Show } from 'solid-js';
import { shownPrompt } from '@/state/dialogs';
import { look } from '@/theme/look';
import { ModalDialog } from './ModalDialog';

/** Mounted once per window (frame/Overlays); keyed, so each prompt opens fresh with its own focus. */
export function PromptDialog() {
  return (
    <Show when={shownPrompt()} keyed>
      {(p) => (
        <ModalDialog id="prompt" open title={p.title} onClose={() => p.answer(false)}>
          <p class={look.text} data-size="base" data-tone="primary">
            {p.message}
          </p>
          <div class="cp-actions">
            <Show when={p.cancelLabel}>
              {(label) => (
                <button type="button" class="cp-button" autofocus={p.danger} onClick={() => p.answer(false)}>
                  {label()}
                </button>
              )}
            </Show>
            <button type="button" class={p.danger ? 'cp-danger' : 'cp-primary'} autofocus={!p.danger} onClick={() => p.answer(true)}>
              {p.confirmLabel}
            </button>
          </div>
        </ModalDialog>
      )}
    </Show>
  );
}
