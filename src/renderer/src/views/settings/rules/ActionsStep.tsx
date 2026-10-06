// Ordered rule actions and compatible kind selection.
import { coverageText } from '@/plugins/presentation';
import { Index, Show, createSignal } from 'solid-js';
import { ruleKinds } from '@shared/ruleKinds';
import { actionInfo, recordedKind, type RuleAction } from '@shared/rules';
import { newRuleAction } from '@shared/ruleSpec';
import { timedCoverText, type TimedTrigger } from '@shared/ruleTime';
import { kindOffered } from '@/plugins/slots';
import { Icon } from '@/ui/icons';
import { kindView } from './kinds';
import { ActionBody } from './ActionBody';
import { Step } from './fields';
import { AddPicker } from './pickers';
import styles from './Rules.module.css';

/** Then: the actions, run in order; each a card that opens to its fields. */
export function ActionsStep(props: {
  actions: RuleAction[];
  timed: TimedTrigger | null;
  onChange: (actions: RuleAction[]) => void;
}) {
  const cover = (): string | undefined => (props.timed ? timedCoverText(props.timed, coverageText().window) : undefined);
  // Plugin actions act on a message, so a timed rule offers none; a plugin that is off offers none either.
  const kinds = (): string[] =>
    ruleKinds('actions')
      .filter(
        (k) =>
          k.targets.includes(props.timed ? 'window' : 'message') &&
          kindOffered(k.type),
      )
      .map((k) => k.type);
  const hint = (type: string): string =>
    (props.timed ? kindView('actions', type)?.windowHint : null) ?? actionInfo(type).hint;
  /** An action’s one-line summary while collapsed; cover is a timed rule’s fixed range. */
  const actionSummary = (a: RuleAction, cover?: string): string =>
    kindView('actions', a.type)?.summary(a.config, cover) ??
    actionInfo(a.type).hint;
  // The first action starts open; one added opens so its fields can be filled.
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set(props.actions.slice(0, 1).map((a) => a.id)));
  const isOpen = (id: string): boolean => opened().has(id);
  const toggle = (id: string): void => {
    const next = new Set(opened());
    if (!next.delete(id)) next.add(id);
    setOpened(next);
  };
  const replace = (a: RuleAction): void => props.onChange(props.actions.map((x) => (x.id === a.id ? a : x)));
  const remove = (id: string): void => props.onChange(props.actions.filter((x) => x.id !== id));
  const move = (i: number, by: -1 | 1): void => {
    const next = [...props.actions];
    const [moved] = next.splice(i, 1);
    if (!moved) return;
    next.splice(i + by, 0, moved);
    props.onChange(next);
  };
  const add = (kind: string): void => {
    const a = newRuleAction(kind);
    setOpened(new Set([...opened(), a.id]));
    props.onChange([...props.actions, a]);
  };

  return (
    <Step title="Then">
      {/* Position-based action rows preserve focus during edits. */}
      <Index each={props.actions}>
        {(a, i) => (
          <div class={styles.action} data-open={isOpen(a().id)}>
            <div class={styles.actionHead}>
              <button
                type="button"
                class={styles.actionToggle}
                aria-expanded={isOpen(a().id)}
                onClick={() => toggle(a().id)}
              >
                <span class="cp-chevron" aria-hidden="true" />
                <span class={styles.actionTitle}>{actionInfo(recordedKind(a())).label}</span>
                <span class={styles.actionSum}>{actionSummary(a(), cover())}</span>
              </button>
              <button
                type="button"
                class={styles.iconButton}
                aria-label="Move up"
                title="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <Icon name="arrowUp" />
              </button>
              <button
                type="button"
                class={styles.iconButton}
                aria-label="Move down"
                title="Move down"
                disabled={i === props.actions.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="arrowDown" />
              </button>
              <button
                type="button"
                class={styles.iconButton}
                aria-label={`Remove ${actionInfo(recordedKind(a())).label}`}
                title="Remove"
                onClick={() => remove(a().id)}
              >
                <Icon name="close" />
              </button>
            </div>
            <Show when={isOpen(a().id)}>
              <div class={styles.actionBody}>
                <ActionBody action={a()} cover={cover()} onChange={replace} />
              </div>
            </Show>
          </div>
        )}
      </Index>
      <div class={styles.inline}>
        <AddPicker
          label="Add action"
          options={() => kinds().map((k) => ({ value: k, label: actionInfo(k).label, hint: hint(k) }))}
          placeholder="Action"
          onPick={add}
        />
        <Show when={!props.actions.length}>
          <span class={styles.meta}>A rule needs at least one action.</span>
        </Show>
      </div>
    </Step>
  );
}
