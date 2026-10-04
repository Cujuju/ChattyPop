import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import type { ContentKind } from '@shared/messageContent';
import { EMPTY_PATTERN_SPEC, buildPattern, specProblem, type PatternSpec } from '@shared/keywordPattern';
import { keywordRegex } from '@shared/keywordPattern';
import { errorText } from '@/ui/format';
import { PatternTester } from './PatternTester';
import { RemovableChip } from './TermChips';
import styles from './PatternBuilder.module.css';
import chips from './TermChips.module.css';

/** What a rule matches by text: the stored pattern, and the builder rule it came from (null when typed). */
export interface MatchValue {
  pattern: string;
  spec: PatternSpec | null;
}

type Mode = 'keywords' | 'builder' | 'regex';
const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/s;
/** Regex flags offered as switches; g and y are dropped when matching, so they aren't offered. */
const FLAGS = [
  { flag: 'i', label: 'Ignore case' },
  { flag: 's', label: '. matches line breaks' },
  { flag: 'm', label: '^ and $ match each line' },
  { flag: 'u', label: 'Unicode (\\p{L}, emoji)' },
] as const;
/** Flags a new regex starts with: any case, Unicode-aware. */
const DEFAULT_FLAGS = 'iu';

const splitKeywords = (text: string): string[] => text.split(',').map((t) => t.trim()).filter(Boolean);

/**
 * A rule's keyword matcher: plain keywords, a rule built from word lists (compiled to a regex), or a raw regex
 * with flag switches. Shows the resulting regex, any error, and a tester against sample text and the archive.
 */
export function PatternBuilder(props: { value: MatchValue; onChange: (v: MatchValue) => void; channelIds: string[] | null; contains: ContentKind[] | null }) {
  const initial = (): Mode => (props.value.spec ? 'builder' : REGEX_PATTERN.test(props.value.pattern.trim()) ? 'regex' : 'keywords');
  const [mode, setMode] = createSignal<Mode>(initial());
  const spec = (): PatternSpec => props.value.spec ?? EMPTY_PATTERN_SPEC;
  const regexParts = () => {
    const m = REGEX_PATTERN.exec(props.value.pattern.trim());
    return m ? { body: m[1]!, flags: m[2]! } : { body: '', flags: DEFAULT_FLAGS };
  };
  const compiled = createMemo((): { re: RegExp | null; error: string | null } => {
    if (mode() === 'builder') {
      const problem = specProblem(spec());
      if (problem) return { re: null, error: problem };
    }
    try {
      return { re: keywordRegex(props.value.pattern), error: null };
    } catch (err) {
      return { re: null, error: errorText(err) };
    }
  });

  /** Errors wait for input: an untouched builder or empty regex isn't a mistake yet. */
  const shownError = (): string | null => {
    const e = compiled().error;
    if (!e) return null;
    const started = mode() === 'builder' ? [...spec().anyOf, ...spec().allOf, ...spec().noneOf].length > 0 : props.value.pattern.trim() !== '';
    return started ? e : null;
  };

  const setSpec = (patch: Partial<PatternSpec>): void => {
    const next = { ...spec(), ...patch };
    props.onChange({ spec: next, pattern: specProblem(next) ? '' : buildPattern(next) });
  };
  const setRegex = (body: string, flags: string): void => props.onChange({ spec: null, pattern: body ? `/${body}/${flags}` : '' });
  const toggleFlag = (flag: string, on: boolean): void => {
    const f = regexParts().flags.replace(flag, '');
    setRegex(regexParts().body, on ? f + flag : f);
  };

  /** Switching carries what it can: keywords seed the builder's "any of" list and back; the builder's regex opens in the regex editor. */
  const switchMode = (next: Mode): void => {
    const from = mode();
    setMode(next);
    if (from === next) return;
    if (next === 'builder') {
      const seed = from === 'keywords' ? splitKeywords(props.value.pattern) : [];
      const s = { ...EMPTY_PATTERN_SPEC, anyOf: seed };
      props.onChange({ spec: s, pattern: specProblem(s) ? '' : buildPattern(s) });
    } else if (next === 'keywords') {
      props.onChange({ spec: null, pattern: from === 'builder' ? spec().anyOf.join(', ') : '' });
    } else {
      props.onChange({ spec: null, pattern: from === 'builder' ? props.value.pattern : '' });
    }
  };

  return (
    <div class={styles.builder}>
      <SegGroup role="radiogroup" ariaLabel="How to match text" value={mode()} onChange={(v: Mode) => switchMode(v)}>
        <SegButton value="keywords" label="Keywords" size="sm" />
        <SegButton value="builder" label="Builder" size="sm" />
        <SegButton value="regex" label="Regex" size="sm" />
      </SegGroup>
      <Switch>
        <Match when={mode() === 'keywords'}>
          <input class={styles.input} type="text" aria-label="Keywords" placeholder="restock, group buy, gb" value={props.value.pattern} onInput={(e) => props.onChange({ spec: null, pattern: e.currentTarget.value })} />
          <p class="cp-hint">Comma-separated; whole words, any case.</p>
        </Match>
        <Match when={mode() === 'builder'}>
          <TermList label="Contains any of" terms={spec().anyOf} onChange={(anyOf) => setSpec({ anyOf })} placeholder="gb, group buy" />
          <TermList label="…and all of" terms={spec().allOf} onChange={(allOf) => setSpec({ allOf })} placeholder="keyboard" />
          <TermList label="…and none of" terms={spec().noneOf} onChange={(noneOf) => setSpec({ noneOf })} placeholder="sold out, closed" />
          <label class="cp-check">
            <input type="checkbox" checked={spec().wholeWords} onChange={(e) => setSpec({ wholeWords: e.currentTarget.checked })} />
            Whole words only
          </label>
          <label class="cp-check">
            <input type="checkbox" checked={spec().matchCase} onChange={(e) => setSpec({ matchCase: e.currentTarget.checked })} />
            Match case
          </label>
          <p class="cp-hint">Enter or comma adds. * is any letters, ? exactly one.</p>
          <Show when={props.value.pattern}>
            <div class="cp-field">
              <span class="cp-label">Regex</span>
              <code class={styles.code}>{props.value.pattern}</code>
              <button type="button" class={styles.linkButton} onClick={() => switchMode('regex')}>
                Edit as regex
              </button>
            </div>
          </Show>
        </Match>
        <Match when={mode() === 'regex'}>
          <div class={styles.regexRow}>
            <span class={styles.slash} aria-hidden="true">/</span>
            <input class={`${styles.input} ${styles.mono}`} type="text" aria-label="Regular expression" placeholder="gb (open|clos(es|ing))" value={regexParts().body} onInput={(e) => setRegex(e.currentTarget.value, regexParts().flags)} />
            <span class={styles.slash} aria-hidden="true">/{regexParts().flags}</span>
          </div>
          <div class="cp-checks">
            <For each={FLAGS}>
              {(f) => (
                <label class="cp-check">
                  <input type="checkbox" checked={regexParts().flags.includes(f.flag)} onChange={(e) => toggleFlag(f.flag, e.currentTarget.checked)} />
                  <span class={styles.mono}>{f.flag}</span> {f.label}
                </label>
              )}
            </For>
          </div>
          <p class="cp-hint">JavaScript regex, tested on the message text.</p>
        </Match>
      </Switch>
      <Show when={shownError()}>
        {(e) => (
          <p class="cp-error" role="alert">
            {e()}
          </p>
        )}
      </Show>
      <PatternTester re={compiled().re} pattern={props.value.pattern} channelIds={props.channelIds} contains={props.contains} />
    </div>
  );
}

/** Words or phrases as removable chips, with an input that adds on Enter or a comma (Backspace in an empty input removes the last). */
function TermList(props: { label: string; terms: string[]; onChange: (terms: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = createSignal('');
  const commit = (): void => {
    const added = splitKeywords(draft()).filter((t) => !props.terms.includes(t));
    setDraft('');
    if (added.length) props.onChange([...props.terms, ...added]);
  };
  return (
    <div class="cp-field">
      <span class="cp-label">{props.label}</span>
      <div class={chips.terms}>
        <For each={props.terms}>
          {(t) => <RemovableChip label={t} onRemove={() => props.onChange(props.terms.filter((x) => x !== t))} />}
        </For>
        <input
          class={chips.termInput}
          type="text"
          aria-label={props.label}
          placeholder={props.terms.length ? '' : props.placeholder}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            if (e.currentTarget.value.includes(',')) commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault(); // Enter adds a term; it must not submit the rule form
              commit();
            } else if (e.key === 'Backspace' && !draft() && props.terms.length) props.onChange(props.terms.slice(0, -1));
          }}
          onBlur={commit}
        />
      </div>
    </div>
  );
}

/** A small link-coloured text button at the start of its column (insert a placeholder, choose an emoji). Other attributes pass through. */
export const LinkButton = (props: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'type'>) => (
  <button type="button" {...props} class={styles.linkButton} />
);
