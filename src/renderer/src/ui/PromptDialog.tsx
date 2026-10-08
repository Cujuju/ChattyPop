// The shown confirmation, notice or text question (state/dialogs) as the app's modal dialog.
import { Show } from 'solid-js';
import { shownPrompt } from '@/state/dialogs';
import { look } from '@/theme/look';
import { ModalDialog } from './ModalDialog';

/** Mounted once per window (frame/Overlays); keyed, so each prompt opens fresh with its own focus. */
export function PromptDialog() {
  return (
    <Show when={shownPrompt()} keyed>
      {(p) => {
        let field: HTMLInputElement | undefined;
        const answer = (ok: boolean): void => p.answer(ok, field?.value);
        return (
          <ModalDialog id="prompt" open title={p.title} onClose={() => answer(false)}>
            <Show
              when={p.input !== undefined}
              fallback={
                <p class={look.text} data-size="base" data-tone="primary">
                  {p.message}
                </p>
              }
            >
              <label class="cp-field">
                <span class="cp-label">{p.message}</span>
                <input
                  ref={field}
                  type="text"
                  value={p.input}
                  autofocus
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.isComposing) return;
                    e.preventDefault();
                    answer(true);
                  }}
                />
              </label>
            </Show>
            <div class="cp-actions">
              <Show when={p.cancelLabel}>
                {(label) => (
                  <button type="button" class="cp-button" autofocus={p.danger} onClick={() => answer(false)}>
                    {label()}
                  </button>
                )}
              </Show>
              <button
                type="button"
                class={p.danger ? 'cp-danger' : 'cp-primary'}
                autofocus={!p.danger && p.input === undefined}
                onClick={() => answer(true)}
              >
                {p.confirmLabel}
              </button>
            </div>
          </ModalDialog>
        );
      }}
    </Show>
  );
}
