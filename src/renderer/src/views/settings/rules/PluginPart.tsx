// Optional plugin condition editors receive valid configurations only while selected.
import { Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { RulePart } from '@shared/rules';
import type { RuleKind } from '@shared/ruleKinds';
import { kindView } from './kinds';
import styles from './Rules.module.css';

/** Selects an optional plugin match or filter and edits its declared configuration. */
export function PluginPart(props: {
  section: 'match' | 'filters';
  kind: RuleKind;
  part: RulePart | undefined;
  onChange(config: unknown): void;
}) {
  return <>
    <label class={styles.checkChip}>
      <input type="checkbox" checked={!!props.part} onChange={(e) => props.onChange(e.currentTarget.checked ? props.kind.create() : undefined)} />
      {props.kind.label}
    </label>
    <Show when={props.part}>
      {(part) => <Dynamic
        component={kindView(props.section, props.kind.type)?.Editor}
        id={`rule-${props.kind.type}`}
        config={part().config}
        onChange={props.onChange}
      />}
    </Show>
  </>;
}
