// Host jev question builder.
import { For, Show, type JSX } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { SCORE_LEVELS_MAX, SCORE_LEVELS_MIN, type JevQuestionSpec } from '@shared/jevQuestion';
import { Select } from '@/ui/Select';
import { Icon } from './icons';
import styles from './JevQuestionBuilder.module.css';

export type JevKind = JevQuestionSpec['type'];
type Of<K extends JevKind> = Extract<JevQuestionSpec, { type: K }>;

/** An option renamed in the builder, so callers can carry state keyed by option name (e.g. which ones alert). */
export interface Renamed {
  from: string;
  to: string;
}

const NONE = 'none';

const KINDS: { value: JevKind; label: string }[] = [
  { value: 'noul', label: 'Yes / no' },
  { value: 'choice', label: 'Pick one' },
  { value: 'score', label: 'Score on levels' },
];
/** Shorter names for the segmented control, where the section label already says "Answer". */
const KIND_SHORT: Record<JevKind, string> = { noul: 'Yes / no', choice: 'Pick one', score: 'Score' };

/** A fresh question of `kind`, with example options or levels to edit. */
export function specStarter(kind: JevKind): JevQuestionSpec {
  switch (kind) {
    case 'noul':
      return { type: 'noul', question: '', yes: '', no: '' };
    case 'choice':
      return { type: 'choice', question: '', options: [{ name: 'yes', description: '' }, { name: 'no', description: '' }] };
    case 'score':
      return { type: 'score', question: '', levels: ['Low', 'Medium', 'High'] };
  }
}

/** A padlock marking a part the app reads by name. */
const Lock = () => (
  <Icon name="lock" class={styles.lock} />
);

/**
 * Builds an owner-written Jev question: its kind, the question about `message`, and what each answer means. Extra
 * fields on `value` (a rule's match condition) are kept through edits; `children` render under the meanings.
 * `roomy` is the full-width layout (Settings → Jev → Queries): the kind as a segmented control and labelled sections.
 */
export function JevQuestionBuilder<T extends JevQuestionSpec>(props: {
  legend: string;
  /** Keeps the legend for screen readers only, where a surrounding label already shows it. */
  legendHidden?: boolean;
  value: T | null;
  onChange: (q: T | null, renamed?: Renamed) => void;
  /** A fresh question of the picked kind. */
  starter: (kind: JevKind) => T;
  /** Offers "No Jev question" (value null). */
  optional?: boolean;
  placeholder: string;
  /** Rendered before each pick-one option, e.g. an "alert on this" tick. */
  optionLead?: (name: string) => JSX.Element;
  /** A score level's badge when the condition counts it (e.g. "Notify"), else null. */
  levelTag?: (level: number) => string | null;
  /** Kinds offered; one kind locks the type (the app reads that shape). Default: all three. */
  kinds?: JevKind[];
  /** The app reads option names: meanings stay editable, names and the option list don't. */
  lockOptionNames?: boolean;
  /** The app reads the level: level text stays editable, their number doesn't. */
  lockLevelCount?: boolean;
  /** Options come from the run (e.g. per-run choices), so none are shown. */
  hideOptions?: boolean;
  roomy?: boolean;
  children?: JSX.Element;
}) {
  const set = (patch: Partial<JevQuestionSpec>, renamed?: Renamed): void => props.onChange({ ...props.value!, ...patch } as T, renamed);
  const spec = (): JevQuestionSpec | null => props.value;
  const offered = () => KINDS.filter((k) => !props.kinds || props.kinds.includes(k.value));
  const kinds = () => (props.optional ? [{ value: NONE, label: 'No Jev question' }, ...offered()] : offered());
  const pick = (v: string): void => props.onChange(v === NONE ? null : props.starter(v as JevKind));
  const locked = (k: JevKind): boolean => !offered().some((o) => o.value === k);
  return (
    <fieldset class={styles.builder} data-roomy={props.roomy ? 'true' : undefined}>
      <legend class={props.legendHidden ? 'cp-visually-hidden' : `cp-label ${styles.label}`}>{props.legend}</legend>
      <Show
        when={props.roomy}
        fallback={<Select class={styles.input} value={props.value?.type ?? NONE} options={kinds()} disabled={!props.optional && offered().length === 1} onChange={pick} />}
      >
        <Show when={spec()}>
          {(cur) => (
            <label class={styles.section}>
              <span class={styles.sectionLabel}>Question</span>
              <textarea class={`${styles.input} ${styles.question}`} rows={2} placeholder={props.placeholder} value={cur().question} onInput={(e) => set({ question: e.currentTarget.value })} />
              <span class="cp-hint">Jev answers only the question as written, so be literal and specific.</span>
            </label>
          )}
        </Show>
        <div class={styles.sectionHead}>
          <span class={styles.sectionLabel}>Answer</span>
          <SegGroup role="radiogroup" ariaLabel="Answer type" value={props.value?.type ?? NONE} onChange={(v: string) => props.value?.type !== v && pick(v)}>
            <For each={KINDS}>
              {(k) => (
                <SegButton
                  value={k.value}
                  label={KIND_SHORT[k.value]}
                  size="md"
                  disabled={locked(k.value)}
                  title={locked(k.value) ? 'The app reads this query’s answer in one shape, so the type stays.' : undefined}
                />
              )}
            </For>
          </SegGroup>
        </div>
      </Show>
      <Show when={spec()}>
        {(cur) => (
          <>
            <Show when={!props.roomy}>
              <textarea class={styles.input} rows={2} placeholder={props.placeholder} value={cur().question} onInput={(e) => set({ question: e.currentTarget.value })} />
              <p class="cp-hint">Write it about `message` (Jev also sees the two messages before it). Jev answers only the question as written, so be literal and specific.</p>
            </Show>
            <Show when={cur().type === 'noul' && (cur() as Of<'noul'>)}>
              {(n) => (
                <div class={styles.meanings}>
                  <label class={styles.meaning}>
                    <span class={styles.meaningLabel} data-answer="yes">
                      Yes means
                    </span>
                    <textarea class={styles.input} rows={2} placeholder="Optional" value={n().yes} onInput={(e) => set({ yes: e.currentTarget.value })} />
                  </label>
                  <label class={styles.meaning}>
                    <span class={styles.meaningLabel}>No means</span>
                    <textarea class={styles.input} rows={2} placeholder="Optional" value={n().no} onInput={(e) => set({ no: e.currentTarget.value })} />
                  </label>
                </div>
              )}
            </Show>
            <Show when={cur().type === 'choice' && !props.hideOptions && (cur() as Of<'choice'>)}>
              {(c) => (
                <>
                  <div class={styles.options}>
                    <For each={c().options}>
                      {(o, i) => (
                        <div class={styles.row}>
                          {props.optionLead?.(o.name)}
                          <span class={styles.optionName}>
                            <input
                              class={styles.input}
                              placeholder="Option"
                              aria-label="Option name"
                              readOnly={props.lockOptionNames}
                              title={props.lockOptionNames ? 'The app reads this name; change what it means instead.' : undefined}
                              value={o.name}
                              onChange={(e) => set({ options: c().options.map((x, j) => (j === i() ? { ...x, name: e.currentTarget.value } : x)) }, { from: o.name, to: e.currentTarget.value })}
                            />
                            <Show when={props.lockOptionNames}>
                              <Lock />
                            </Show>
                          </span>
                          <textarea
                            class={`${styles.input} ${styles.grow}`}
                            rows={1}
                            placeholder="What it means (optional)"
                            aria-label="What it means"
                            value={o.description}
                            onChange={(e) => set({ options: c().options.map((x, j) => (j === i() ? { ...x, description: e.currentTarget.value } : x)) })}
                          />
                          <Show when={!props.lockOptionNames}>
                            <button type="button" class={`cp-button ${styles.button}`} onClick={() => set({ options: c().options.filter((_, j) => j !== i()) })}>
                              Remove
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={!props.lockOptionNames}>
                    <button type="button" class={`cp-button ${styles.button}`} onClick={() => set({ options: [...c().options, { name: `option ${c().options.length + 1}`, description: '' }] })}>
                      Add option
                    </button>
                  </Show>
                  <p class="cp-hint">
                    Jev picks the one option that fits best; say what each means when the name alone is ambiguous.
                    {props.lockOptionNames ? ' The app reads the names, so only their meanings change.' : ''}
                  </p>
                </>
              )}
            </Show>
            <Show when={cur().type === 'score' && (cur() as Of<'score'>)}>
              {(s) => (
                <>
                  <ol class={styles.ladder}>
                    <For each={s().levels}>
                      {(l, i) => (
                        <li class={styles.level} data-counts={props.levelTag?.(i()) ? 'true' : undefined}>
                          <span class={styles.levelNo}>{i()}</span>
                          <textarea class={`${styles.input} ${styles.grow}`} rows={1} aria-label={`Level ${i()}`} value={l} onChange={(e) => set({ levels: s().levels.map((x, j) => (j === i() ? e.currentTarget.value : x)) })} />
                          <Show when={props.levelTag?.(i())}>{(tag) => <span class={styles.levelTag}>{tag()}</span>}</Show>
                          <Show when={!props.lockLevelCount && s().levels.length > SCORE_LEVELS_MIN}>
                            <button type="button" class={`cp-button ${styles.button}`} onClick={() => set({ levels: s().levels.filter((_, j) => j !== i()) })}>
                              Remove
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={!props.lockLevelCount && s().levels.length < SCORE_LEVELS_MAX}>
                    <button type="button" class={`cp-button ${styles.button}`} onClick={() => set({ levels: [...s().levels, `Level ${s().levels.length}`] })}>
                      Add level
                    </button>
                  </Show>
                  <p class="cp-hint">
                    Levels go from lowest (0) to highest; describe each so Jev can tell them apart.
                    {props.lockLevelCount ? ' The app reads the level, so the number of levels stays.' : ''}
                  </p>
                </>
              )}
            </Show>
            {props.children}
          </>
        )}
      </Show>
    </fieldset>
  );
}
