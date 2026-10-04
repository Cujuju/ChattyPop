import { For, Show, type JSX } from 'solid-js';
import type { Rule } from '@shared/rules';
import { ruleSwitchLocked } from '@/state/rules';
import { Switch } from '@/ui/Switch';
import styles from './Rules.module.css';

/** A section of the rule page: a title (with an optional muted note), then its card(s). */
export function Step(props: { title: string; note?: string; children: JSX.Element }) {
  return (
    <section class={styles.step} aria-label={props.title}>
      <div class={styles.stepHead}>
        <h3 class={styles.stepTitle}>{props.title}</h3>
        <Show when={props.note}>
          <span class={styles.stepSum}>{props.note}</span>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** A rule's on/off switch; locked rules say why. */
export function RuleSwitch(props: { rule: Rule | null; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const locked = () => !!props.rule && ruleSwitchLocked(props.rule);
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled || locked()}
      label={props.rule ? `Run ${props.rule.name}` : 'Rule on'}
      title={locked() ? (props.rule!.error ?? 'Needs Jev: set it up in Settings → Jev') : props.checked ? 'On' : 'Off'}
      onChange={props.onChange}
    />
  );
}

/** A labelled row in a step's card: the label column, then the controls and an optional hint under them. */
export function Field(props: { label: JSX.Element; hint?: JSX.Element; for?: string; tone?: 'narrow'; children: JSX.Element }) {
  return (
    <div class={styles.field} data-tone={props.tone}>
      <Show when={props.for} fallback={<div class={styles.fieldLabel}>{props.label}</div>}>
        <label class={styles.fieldLabel} for={props.for}>
          {props.label}
        </label>
      </Show>
      <div class={styles.fieldBody}>
        {props.children}
        <Show when={props.hint}>
          <p class={styles.hint}>{props.hint}</p>
        </Show>
      </div>
    </div>
  );
}

/** "or" between match fields: any one of them is enough. */
export const Or = () => <div class={styles.or}>or</div>;

export interface CheckItem<T> {
  id: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** Inline checkbox chips; `chosen` in tick order. */
export function Checks<T extends string | number>(props: { items: CheckItem<T>[]; chosen: readonly T[]; onChange: (ids: T[]) => void }) {
  const toggle = (id: T, on: boolean): void => props.onChange(on ? [...props.chosen, id] : props.chosen.filter((x) => x !== id));
  return (
    <div class={styles.chips}>
      <For each={props.items}>
        {(it) => (
          <label class={styles.checkChip} title={it.hint}>
            <input type="checkbox" checked={props.chosen.includes(it.id)} disabled={it.disabled} onChange={(e) => toggle(it.id, e.currentTarget.checked)} />
            {it.label}
          </label>
        )}
      </For>
    </div>
  );
}

/** Drops an empty list, so an unset gate or narrowing doesn't narrow. */
export const listOrUndefined = <T,>(v: T[]): T[] | undefined => (v.length ? v : undefined);

/** A count badge on a rules-list row (unread alerts): the accent is reserved for unread. */
export const RuleBadge = (props: { children: JSX.Element; title?: string }) => (
  <span class={styles.badge} title={props.title}>
    {props.children}
  </span>
);
