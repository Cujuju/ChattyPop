// Host presentation with active feature wording.
import { optionsNote } from '@/plugins/featureWording';
import { For, Show, createSignal } from 'solid-js';
import { allowedTypes, effectiveJevQuery, type JevQueryDef, type JevQueryUse } from '@shared/jevQueries';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { jevQueryOverrides, saveJevQuery } from '@/state/jevQueries';
import { jevFeatureLocked, toggleJevFeature } from '@/state/jevStatus';
import { aiSettings } from '@/state/preferences';
import { createAction } from '@/ui/action';
import { Switch } from '@/ui/Switch';
import { JevQuestionField, conditionWording } from '@/ui/JevQuestionField';
import { jevFeatureLabel } from './jevFeatures';
import { jevFeatureOn } from '@shared/settings';
import { JevRerun } from './JevRerun';
import settings from './Settings.module.css';
import styles from './JevQueryEditor.module.css';

/** Why some parts can't change, per use; null = everything can. */
const LOCK_NOTE = (query: JevQueryDef): Record<JevQueryUse, string | null> => ({
  decision: null,
  display: null,
  rank: 'The app sorts by this answer, so it stays yes/no or a score.',
  labels: 'The chosen option is shown as a label, so it stays pick-one; options can be added, renamed or removed.',
  'fixed-options': 'The app reads the option names, so the type and names stay; what each means can change.',
  'fixed-levels': 'The app reads the level, so the type and the number of levels stay; what each level means can change.',
  'dynamic-options': optionsNote(query),
});

/** Names in backticks: what Jev reads, as the question may refer to it. */
const BACKTICKED = /`([^`]+)`/g;

const same = (a: CustomJevQuestion, b: CustomJevQuestion): boolean => JSON.stringify(a) === JSON.stringify(b);

type Status = { kind: 'error' | 'saved'; text: string } | null;

/**
 * One built-in query, top to bottom: where it's used and its on/off switch, what Jev reads, the question and its answers,
 * when it counts, and (per-message queries) a run on past messages; save and reset stay in the footer.
 */
export function JevQueryEditor(props: { def: JevQueryDef }) {
  const d = props.def;
  const saved = () => effectiveJevQuery(d, jevQueryOverrides());
  const [draft, setDraft] = createSignal<CustomJevQuestion>(saved());
  const action = createAction();
  const { busy } = action;
  const [savedText, setSavedText] = createSignal<string | null>(null);
  const status = (): Status => {
    const error = action.error();
    const done = savedText();
    return error ? { kind: 'error', text: error } : done ? { kind: 'saved', text: done } : null;
  };
  const clearStatus = (): void => {
    action.setError(null);
    setSavedText(null);
  };
  const reads = [...new Set([...d.sees.matchAll(BACKTICKED), ...(d.vars ?? []).flatMap((v) => [...v.matchAll(BACKTICKED)])].map((m) => m[1]!))];
  const edited = () => d.id in jevQueryOverrides();
  const dirty = () => !same(draft(), saved());

  const save = async (q: CustomJevQuestion | null): Promise<void> => {
    setSavedText(null);
    const done = await action.run(async () => {
      await saveJevQuery(d.id, q);
      return true;
    });
    if (!done) return;
    setDraft(saved());
    setSavedText(q ? 'Saved. It applies to new messages and runs from now on.' : 'Back to the default.');
  };

  const idle = (): string => (dirty() ? 'Unsaved changes' : edited() ? 'Edited · applies to new messages and runs' : 'Default');

  return (
    <section class={styles.detail} data-group={d.group} aria-labelledby="jev-query-title">
      <div class={styles.detailScroll}>
        <header class={styles.detailHead}>
          <div class={styles.titleBlock}>
            <span class={styles.groupChip}>{d.group}</span>
            <h3 id="jev-query-title" class={styles.queryTitle}>
              {d.label}
            </h3>
          </div>
          <div class={styles.switches}>
            <For each={d.features}>
              {(f) => (
                <label class={styles.switch}>
                  {jevFeatureLabel(f)}
                  <Switch checked={jevFeatureOn(aiSettings().jev, f)} disabled={jevFeatureLocked(f)} onChange={(on) => toggleJevFeature(f, on)} />
                </label>
              )}
            </For>
          </div>
        </header>
        <div class={styles.block}>
          <span class="cp-stat-label">Jev reads</span>
          <div class={styles.chips}>
            <For each={reads}>{(r) => <code class={styles.chip}>{r}</code>}</For>
          </div>
          <p class="cp-note">
            {d.sees}
            <Show when={d.vars?.length}> The app adds {d.vars!.join('; ')}.</Show>
            <Show when={d.placeholders?.length}> Keep {d.placeholders!.join(', ')} in the question: the app fills it in for each item.</Show>
          </p>
          <Show when={LOCK_NOTE(d)[d.use]}>
            <p class="cp-note">{LOCK_NOTE(d)[d.use]}</p>
          </Show>
        </div>
        <JevQuestionField
          roomy
          value={draft()}
          onChange={(q) => {
            if (!q) return;
            setDraft(q);
            clearStatus();
          }}
          optional={false}
          showCondition={d.condition !== null}
          wording={conditionWording(d.condition ?? 'Count', d.label, '')}
          kinds={allowedTypes(d)}
          lockOptionNames={d.use === 'fixed-options'}
          lockLevelCount={d.use === 'fixed-levels'}
          hideOptions={d.use === 'dynamic-options'}
        />
        <Show when={d.perMessage}>
          <JevRerun def={d} />
        </Show>
      </div>
      <footer class={styles.foot}>
        <span class={styles.status} data-kind={status()?.kind} role={status()?.kind === 'error' ? 'alert' : 'status'}>
          {status()?.text ?? idle()}
        </span>
        <Show when={dirty()}>
          <button type="button" class={`cp-button ${settings.button}`} disabled={busy()} onClick={() => setDraft(saved())}>
            Undo changes
          </button>
        </Show>
        <button type="button" class={`cp-button ${settings.button}`} disabled={busy() || (!edited() && same(draft(), d.defaults))} onClick={() => void save(null)}>
          Reset to default
        </button>
        <button type="button" class="cp-primary cp-primary-lg" disabled={busy() || !dirty()} onClick={() => void save(draft())}>
          Save
        </button>
      </footer>
    </section>
  );
}
