import { For, Match, Show, Switch, createEffect, createSignal, on } from 'solid-js';
import type { ModalField } from '@shared/commands';
import { botModal, closeBotModal, submitBotModal } from '@/state/commands';
import { createAction } from '@/ui/action';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { Markdown } from '@/ui/Markdown';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './BotModal.module.css';

type Values = Record<string, string | string[]>;

const initialValues = (fields: ModalField[]): Values =>
  Object.fromEntries(
    fields.flatMap((f): [string, string | string[]][] =>
      f.kind === 'text' ? [[f.customId, f.value]] : f.kind === 'select' ? [[f.customId, f.options.filter((o) => o.selected).map((o) => o.value)]] : [],
    ),
  );

/** A field left empty that the app requires. */
const missing = (f: ModalField, v: Values): boolean => {
  if (f.kind === 'info' || !f.required) return false;
  const x = v[f.customId];
  return f.kind === 'text' ? !(typeof x === 'string' && x.trim()) : !(Array.isArray(x) && x.length >= Math.max(1, f.minValues));
};

/** A bot's pop-up form (Discord's modal): its fields, then Submit, which sends the answers to the app. */
export function BotModalWindow() {
  const [values, setValues] = createSignal<Values>({});
  const action = createAction();
  createEffect(
    on(botModal, (m) => {
      action.cancel();
      setValues(m ? initialValues(m.fields) : {});
    }),
  );
  const set = (id: string, v: string | string[]): void => void setValues((all) => ({ ...all, [id]: v }));
  const ready = (): boolean => !action.busy() && !(botModal()?.fields ?? []).some((f) => missing(f, values()));

  return (
    <FloatingWindow id="botModal" open={botModal() !== null} class={`${chrome.dialog} ${styles.window}`} aria-label={botModal()?.title ?? 'Form'} onClose={closeBotModal}>
      <WindowHeader title={botModal()?.title ?? ''} classes={chrome} closeLabel="Cancel" onClose={closeBotModal} />
      <form
        class={`${chrome.body} ${styles.form}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready()) void action.run(() => submitBotModal(values()));
        }}
      >
        <Show when={botModal()?.appName}>{(n) => <p class="cp-hint">From {n()}</p>}</Show>
        <For each={botModal()?.fields ?? []}>
          {(f) => (
            <Switch>
              <Match when={f.kind === 'info' && f}>{(i) => <Markdown text={i().content} mentions={{}} />}</Match>
              <Match when={f.kind === 'text' && f}>
                {(t) => (
                  <label class="cp-field">
                    <span class="cp-label">
                      {t().label}
                      <Show when={t().required}>
                        <span class={styles.required}> *</span>
                      </Show>
                    </span>
                    <Show when={t().description}>{(d) => <span class="cp-hint">{d()}</span>}</Show>
                    <Show
                      when={t().paragraph}
                      fallback={
                        <input
                          type="text"
                          value={(values()[t().customId] as string) ?? ''}
                          placeholder={t().placeholder ?? ''}
                          minLength={t().minLength ?? undefined}
                          maxLength={t().maxLength ?? undefined}
                          onInput={(e) => set(t().customId, e.currentTarget.value)}
                        />
                      }
                    >
                      <textarea
                        class={styles.paragraph}
                        value={(values()[t().customId] as string) ?? ''}
                        placeholder={t().placeholder ?? ''}
                        minLength={t().minLength ?? undefined}
                        maxLength={t().maxLength ?? undefined}
                        onInput={(e) => set(t().customId, e.currentTarget.value)}
                      />
                    </Show>
                  </label>
                )}
              </Match>
              <Match when={f.kind === 'select' && f}>
                {(s) => (
                  <fieldset class={`cp-field ${styles.choices}`}>
                    <legend class="cp-label">{s().label || s().placeholder}</legend>
                    <For each={s().options}>
                      {(o) => {
                        const chosen = (): string[] => (values()[s().customId] as string[]) ?? [];
                        return (
                          <label class="cp-check">
                            <input
                              type={s().maxValues > 1 ? 'checkbox' : 'radio'}
                              name={s().customId}
                              checked={chosen().includes(o.value)}
                              onChange={(e) =>
                                set(
                                  s().customId,
                                  s().maxValues > 1
                                    ? e.currentTarget.checked
                                      ? [...chosen(), o.value].slice(0, s().maxValues)
                                      : chosen().filter((v) => v !== o.value)
                                    : [o.value],
                                )
                              }
                            />
                            {o.label}
                          </label>
                        );
                      }}
                    </For>
                  </fieldset>
                )}
              </Match>
            </Switch>
          )}
        </For>
        <Show when={action.error()}>
          <p class="cp-error" role="alert">
            {action.error()}
          </p>
        </Show>
        <div class="cp-actions">
          <button type="button" class="cp-button" onClick={closeBotModal}>
            Cancel
          </button>
          <button type="submit" class="cp-primary" disabled={!ready()}>
            {action.busy() ? 'Sending…' : 'Submit'}
          </button>
        </div>
      </form>
    </FloatingWindow>
  );
}
