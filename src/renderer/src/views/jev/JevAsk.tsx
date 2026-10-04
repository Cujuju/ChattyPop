import { api } from '@/api';
import { For, Show, createEffect, createSignal, on } from 'solid-js';
import type { JevAskResult } from '@shared/contract';
import type { JevQuestionSpec } from '@shared/jevQuestion';
import { openArchive } from '@/state/archive';
import { channelById, channelLabel } from '@/state/directory';
import { projectedJevUsd } from '@/state/jevSpend';
import { jevAskChannel, setJevAskChannel } from '@/state/ui';
import { createAction } from '@/ui/action';
import { jevValueText, shortDateTime, usdText } from '@/ui/format';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { JevQuestionBuilder, specStarter } from '@/ui/JevQuestionBuilder';
import { Select } from '@/ui/Select';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './JevWindows.module.css';

/** Latest-message counts offered; the core caps a run at ASK_RANGE_MAX (400). */
const LIMITS = [50, 100, 200, 400] as const;
const DEFAULT_LIMIT = 100;
/** Results listed; the rest are summarised as a count. */
const SHOWN = 30;

/** Custom Jev call: your own yes/no or pick-one question about each of a channel's latest messages, best matches first. */
export function JevAsk() {
  const [question, setQuestion] = createSignal<JevQuestionSpec>(specStarter('noul'));
  const [limit, setLimit] = createSignal<number>(DEFAULT_LIMIT);
  const [result, setResult] = createSignal<JevAskResult | null>(null);
  const action = createAction();
  const { busy, error } = action;
  const channelName = (): string => {
    const c = channelById(jevAskChannel() ?? '');
    return c ? channelLabel(c) : '';
  };

  createEffect(
    on(jevAskChannel, (id) => {
      if (!id) return;
      action.cancel(); // a run for the previous channel must not land under this one
      setResult(null);
    }),
  );

  const run = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    const channelId = jevAskChannel();
    if (!channelId) return;
    const r = await action.run(() => api.core.jevAskRange({ channelId, question: question(), limit: limit() }));
    if (r) setResult(r);
  };

  return (
    // Hidden, not closed, while privacy mode hides its channel.
    <FloatingWindow id="jevAsk" open={channelName() !== ''} class={chrome.dialog} aria-label="Ask Jev" onClose={() => setJevAskChannel(null)}>
      <WindowHeader title={`Ask Jev · ${channelName()}`} classes={chrome} closeLabel="Close" onClose={() => setJevAskChannel(null)} />
      <div class={chrome.body}>
        <form class={`cp-field ${styles.field}`} onSubmit={(e) => void run(e)}>
          <JevQuestionBuilder
            legend="Question about each message"
            placeholder="e.g. Does `message` recommend a keyboard?"
            value={question()}
            starter={specStarter}
            onChange={(q) => q && setQuestion(q)}
          />
          <label class={styles.label}>Latest messages to ask about</label>
          <Select class={styles.input} value={String(limit())} options={LIMITS.map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => setLimit(Number(v))} />
          <p class="cp-hint">
            Sends each message (with the two before it) to TypeSafe, one question each: up to {limit()} messages ≈ {usdText(projectedJevUsd(limit()))}.
          </p>
          <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !question().question.trim()}>
            {busy() ? 'Asking…' : 'Ask'}
          </button>
        </form>
        <Show when={error()}>
          <p class="cp-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={result()}>
          {(r) => (
            <>
              <p class="cp-hint">
                Asked about {r().asked} messages{r().failed ? ` (${r().failed} failed)` : ''}
                {r().costUsd !== null ? ` · ${usdText(r().costUsd!)}` : ''}. Model estimates, highest first.
              </p>
              <dl class={styles.facts}>
                <For each={r().results.slice(0, SHOWN)}>
                  {(h) => (
                    <>
                      <dt>{jevValueText(r().kind, h.value, h.choice)}</dt>
                      <dd>
                        <button
                          type="button"
                          class={`cp-button ${styles.button}`}
                          title="Open in the Archive"
                          onClick={() => {
                            setJevAskChannel(null);
                            void openArchive(h.channelId, h.messageId);
                          }}
                        >
                          {shortDateTime(h.ts)}
                        </button>{' '}
                        {h.content}
                      </dd>
                    </>
                  )}
                </For>
              </dl>
              <Show when={r().results.length > SHOWN}>
                <p class="cp-hint">+{r().results.length - SHOWN} more with lower values.</p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </FloatingWindow>
  );
}
