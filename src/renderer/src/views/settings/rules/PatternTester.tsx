import { For, Show, createSignal, type JSX } from 'solid-js';
import type { ContentKind } from '@shared/messageContent';
import { matchRanges } from '@shared/keywordPattern';
import type { PatternPreview } from '@shared/keywordPattern';
import { MS_PER_DAY } from '@shared/units';
import { openArchive } from '@/state/archive';
import { patternPreview } from '@/state/rules';
import { createAction } from '@/ui/action';
import { countText, shortDateTime as when } from '@/ui/format';
import styles from './PatternBuilder.module.css';

/** Highlights drawn per text at most; beyond it the rest shows plain. */
const MAX_HIGHLIGHTS = 50;

/** `text` with each match of `re` marked. */
function Highlighted(props: { re: RegExp | null; text: string }): JSX.Element {
  const parts = () => {
    if (!props.re) return [{ text: props.text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (const [start, end] of matchRanges(props.re, props.text, MAX_HIGHLIGHTS)) {
      if (start > at) out.push({ text: props.text.slice(at, start), hit: false });
      out.push({ text: props.text.slice(start, end), hit: true });
      at = end;
    }
    if (at < props.text.length) out.push({ text: props.text.slice(at), hit: false });
    return out;
  };
  return <For each={parts()}>{(p) => (p.hit ? <mark class={styles.hit}>{p.text}</mark> : p.text)}</For>;
}

/** Tries a pattern: live on sample text, and on demand against recent archived messages in the rule's channels. */
export function PatternTester(props: { re: RegExp | null; pattern: string; channelIds: string[] | null; contains: ContentKind[] | null }) {
  const [open, setOpen] = createSignal(false);
  const [sample, setSample] = createSignal('');
  const [preview, setPreview] = createSignal<PatternPreview | null>(null);
  const [checked, setChecked] = createSignal<string | null>(null);
  const action = createAction();
  const { busy, error } = action;
  const sampleHits = () => (props.re && sample() ? matchRanges(props.re, sample(), MAX_HIGHLIGHTS).length : 0);

  const check = async (): Promise<void> => {
    const pattern = props.pattern;
    const p = await action.run(() => patternPreview(pattern, props.channelIds, props.contains));
    if (!p) return;
    setPreview(p);
    setChecked(pattern);
  };

  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class={styles.linkButton} onClick={() => setOpen(true)}>
          Test it
        </button>
      }
    >
      <div class={styles.tester}>
        <label class="cp-field">
          <span class="cp-label">Try it</span>
          <textarea class={styles.input} rows={2} placeholder="Paste or type a message to test" value={sample()} onInput={(e) => setSample(e.currentTarget.value)} />
        </label>
        <Show when={sample()}>
          <p class={styles.sample} aria-live="polite">
            <Highlighted re={props.re} text={sample()} />
          </p>
          <p class="cp-hint">{props.re ? (sampleHits() ? `Matches (${countText(sampleHits(), 'hit')} marked).` : 'No match.') : 'Nothing to test yet.'}</p>
        </Show>
        <div class="cp-actions">
          <button type="button" class="cp-button" disabled={!props.re || busy()} onClick={() => void check()}>
            {busy() ? 'Checking…' : 'Check the archive'}
          </button>
          <Show when={preview() && checked() !== props.pattern}>
            <span class="cp-hint">Pattern changed since the check.</span>
          </Show>
        </div>
        <Show when={error()}>
          <p class="cp-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={preview()}>
          {(p) => (
            <div class="cp-field">
              <p class="cp-hint">
                {p().matched} of {p().scanned} messages from the last {Math.round((Date.now() - p().sinceTs) / MS_PER_DAY)} days match
                {p().matched > p().hits.length ? `; the newest ${p().hits.length} are shown` : ''}.
              </p>
              <ul class={styles.previewList}>
                <For each={p().hits}>
                  {(h) => (
                    <li>
                      <button type="button" class={styles.previewHit} title="Show in the Archive" onClick={() => void openArchive(h.channelId, h.messageId)}>
                        <span class={styles.previewMeta}>
                          {h.authorName} · #{h.channelName} · {when(h.ts)}
                        </span>
                        <span class={styles.previewText}>
                          <Highlighted re={props.re} text={h.text} />
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
