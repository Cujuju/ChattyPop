import { Show, createSignal } from 'solid-js';
import { patternName } from '@shared/keywordPattern';
import { contentLabels } from '@shared/messageContent';
import type { Rule, RuleInput, RuleSpec } from '@shared/rules';
import { timedTriggerText, type TimedTrigger } from '@shared/ruleTime';
import {
  confirmDeleteRule,
  createRule,
  guardRulePage,
  newRuleDraft,
  ruleInputOf,
  rules,
  saveRule,
  setRuleEnabled,
} from '@/state/rules';
import { createAction } from '@/ui/action';
import { Icon } from '@/ui/icons';
import { ActionsStep } from './ActionsStep';
import { GatesStep } from './GatesStep';
import { RuleSwitch } from './fields';
import { MatchStep } from './MatchStep';
import { RuleActivity } from './RuleActivity';
import { DAY_NAMES } from './summaries';
import styles from './Rules.module.css';

/** A rule's name when the owner leaves it empty: when it runs if timed, else from what it matches, else what it does. */
function nameFor(input: RuleInput): string {
  const { trigger, match, narrow, actions } = input.spec;
  if (trigger.type === 'timed') return timedTriggerText(trigger.config as TimedTrigger, DAY_NAMES);
  const text = match.find((p) => p.type === 'text')?.config as import('@shared/ruleKinds/host').TextConfig | undefined;
  const meaning = match.find((p) => p.type === 'meaning')?.config as string | undefined;
  const jev = match.find((p) => p.type === 'jev')?.config as
    import('@shared/jevQuestion').CustomJevQuestion | undefined;
  const contents = narrow.find((p) => p.type === 'contains')?.config as
    import('@shared/messageContent').ContentKind[] | undefined;
  return (
    (text ? patternName(text.pattern) : '') ||
    meaning?.trim() ||
    jev?.question.trim() ||
    contentLabels(contents ?? []) ||
    // An empty keyword or question field is not “every message”.
    (actions.length && !match.length ? 'Every message' : 'New rule')
  );
}

/** Sorts an object's keys, so the same fields set in another order serialize alike. */
const sortedKeys = (_key: string, v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v;
/** Its editable fields but `enabled`, which the rule's switch saves at once. */
const fieldsOf = (input: RuleInput): string => JSON.stringify({ ...input, enabled: null }, sortedKeys);

/** One rule as a page: name and actions, then When, If (not for a timed rule), Then and recent runs. `ruleId` null edits the draft. */
export function RuleEditor(props: { ruleId: number | null; onClose: () => void }) {
  const stored = (): Rule | null =>
    props.ruleId === null ? null : (rules().find((r) => r.id === props.ruleId) ?? null);
  const first = stored();
  const [saved, setSaved] = createSignal<RuleInput>(first ? ruleInputOf(first) : structuredClone(newRuleDraft()));
  const [input, setInput] = createSignal<RuleInput>(structuredClone(saved()));
  const timed = (): TimedTrigger | null =>
    input().spec.trigger.type === 'timed' ? (input().spec.trigger.config as TimedTrigger) : null;
  const dirty = (): boolean => fieldsOf(input()) !== fieldsOf(saved());
  const setSpec = (patch: Partial<RuleSpec>): void => {
    setInput((cur) => ({ ...cur, spec: { ...cur.spec, ...patch } }));
  };
  const action = createAction();
  const { busy, error } = action;
  guardRulePage(dirty);
  // Revert remounts the steps to reset their view state.
  const [generation, setGeneration] = createSignal(1);
  const revert = (): void => {
    setInput(structuredClone(saved()));
    setGeneration(generation() + 1);
  };

  const enabled = (): boolean => stored()?.enabled ?? input().enabled;
  const setEnabled = (on: boolean): void => {
    const r = stored();
    if (r) void action.run(() => setRuleEnabled(r, on));
    else setInput((cur) => ({ ...cur, enabled: on }));
  };

  const save = (e: SubmitEvent): void => {
    e.preventDefault();
    const r = stored();
    const next = { ...input(), name: input().name.trim() || nameFor(input()), enabled: enabled() };
    void action.run(async () => {
      if (!r) return createRule(next); // opens the new rule, remounting this page on it
      await saveRule(r.id, next);
      setInput(next);
      setSaved(structuredClone(next));
    });
  };
  const remove = (r: Rule): void =>
    void action.run(async () => {
      if (await confirmDeleteRule(r)) props.onClose();
    });

  return (
    <form class={styles.editor} aria-label={stored() ? `Edit rule ${stored()!.name}` : 'New rule'} onSubmit={save}>
      <div class={styles.editorHead}>
        <input
          class={styles.nameInput}
          type="text"
          aria-label="Rule name"
          placeholder={nameFor(input())}
          value={input().name}
          onInput={(e) => setInput((cur) => ({ ...cur, name: e.currentTarget.value }))}
        />
        {/* A saved rule's switch is in the list; this one shows only for a draft or when the list is hidden. */}
        <span class={styles.headSwitch} data-draft={!stored()}>
          <RuleSwitch rule={stored()} checked={enabled()} disabled={busy()} onChange={setEnabled} />
        </span>
        <div class={styles.editorActions}>
          <Show
            when={stored()}
            fallback={
              <>
                <button type="button" class="cp-button" onClick={() => props.onClose()}>
                  Cancel
                </button>
                <button type="submit" class="cp-primary" disabled={busy()}>
                  Add rule
                </button>
              </>
            }
          >
            {(r) => (
              <>
                <Show when={dirty()}>
                  <button type="button" class={styles.iconButton} aria-label="Revert changes" title="Revert changes" disabled={busy()} onClick={revert}>
                    <Icon name="undo" />
                  </button>
                  <button type="submit" class={styles.iconButton} data-tone="primary" aria-label="Save" title="Save" disabled={busy()}>
                    <Icon name="check" />
                  </button>
                </Show>
                <Show when={!r().builtin}>
                  <button type="button" class={styles.iconButton} data-tone="danger" aria-label="Delete rule" title="Delete rule" disabled={busy()} onClick={() => remove(r())}>
                    <Icon name="trash" />
                  </button>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
      <Show when={error() ?? stored()?.error}>
        {(e) => (
          <p class={`cp-error ${styles.editorError}`} role="alert">
            {e()}
          </p>
        )}
      </Show>
      <div class={styles.editorScroll}>
        <Show when={generation()} keyed>
          <GatesStep
            input={input()}
            rule={stored()}
            onSpec={setSpec}
            onDiscordSend={(discordSend) => setInput((cur) => ({ ...cur, discordSend }))}
          />
          <Show when={!timed()}>
            <MatchStep input={input()} rule={stored()} onSpec={setSpec} />
          </Show>
          <ActionsStep actions={input().spec.actions} timed={timed()} onChange={(actions) => setSpec({ actions })} />
        </Show>
        <Show when={stored()}>{(r) => <RuleActivity rule={r()} />}</Show>
      </div>
    </form>
  );
}
