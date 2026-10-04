import { api } from '@/api';
import { For, Show, createEffect, createSignal, on } from 'solid-js';
import type { JevCheckResult } from '@shared/contract';
import type { JevQuestionSpec } from '@shared/jevQuestion';
import { projectedJevUsd } from '@/state/jevSpend';
import { jevCheckFor, setJevCheckFor } from '@/state/ui';
import { createAction } from '@/ui/action';
import { jevValueText, usdText } from '@/ui/format';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { JevQuestionBuilder, specStarter } from '@/ui/JevQuestionBuilder';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './JevWindows.module.css';

/** Your own question adds one question to the check's request. */
const ASK_QUESTIONS = 1;

/**
 * Jev's read of one message (right-click → Jev check): the standard checks, class labels, your custom-question
 * rules' Jev questions, and your own question. Runs only when opened; sends only this message and the two before it.
 */
export function JevCheck() {
  const [result, setResult] = createSignal<JevCheckResult | null>(null);
  const action = createAction();
  const { busy, error } = action;
  const [ask, setAsk] = createSignal<JevQuestionSpec>(specStarter('noul'));

  const run = async (withAsk: boolean): Promise<void> => {
    const m = jevCheckFor();
    if (!m) return;
    // A newer run (another message, or your question) supersedes this one, so its answer never shows under it.
    const r = await action.run(() => api.core.jevCheckMessage(m.id, withAsk ? ask() : null));
    if (r) setResult(r);
  };

  createEffect(
    on(jevCheckFor, (m) => {
      if (!m) return;
      setResult(null);
      void run(false);
    }),
  );

  return (
    <FloatingWindow id="jevCheck" open={jevCheckFor() !== null} class={chrome.dialog} aria-label="Jev check" onClose={() => setJevCheckFor(null)}>
      <WindowHeader title="Jev check" classes={chrome} closeLabel="Close" onClose={() => setJevCheckFor(null)} />
      <div class={chrome.body}>
        <Show when={jevCheckFor()}>
          {(m) => (
            <p class="cp-hint">
              {m().author.name}: {m().content}
            </p>
          )}
        </Show>
        <p class="cp-hint">Model estimates, not verified facts. Only this message and the two before it were sent to TypeSafe.</p>
        <Show when={busy() && !result()}>
          <p class="cp-hint">Asking Jev…</p>
        </Show>
        <Show when={error()}>
          <p class="cp-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={result()}>
          {(r) => (
            <dl class={styles.facts}>
              <For each={r().checks}>
                {(c) => (
                  <>
                    <dt>{c.label}</dt>
                    <dd>
                      <Show when={c.kind !== 'score'}>
                        <meter min={0} max={1} value={c.value} />{' '}
                      </Show>
                      {jevValueText(c.kind, c.value, c.choice)}
                    </dd>
                  </>
                )}
              </For>
            </dl>
          )}
        </Show>
        <Show when={result()?.costUsd !== null && result()?.costUsd !== undefined}>
          <p class="cp-hint">Cost {usdText(result()!.costUsd!)}</p>
        </Show>
        <form
          class={`cp-field ${styles.field}`}
          onSubmit={(e) => {
            e.preventDefault();
            void run(true);
          }}
        >
          <JevQuestionBuilder legend="Ask Jev about this message" placeholder="e.g. Is `message` sarcastic?" value={ask()} starter={specStarter} onChange={(q) => q && setAsk(q)} />
          <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !ask().question.trim()}>
            {busy() ? 'Asking…' : 'Ask'}
          </button>
          <p class="cp-hint">Runs the checks above again with your question added, in one request ≈ {usdText(projectedJevUsd((result()?.checks.length ?? 0) + ASK_QUESTIONS))}.</p>
        </form>
      </div>
    </FloatingWindow>
  );
}
