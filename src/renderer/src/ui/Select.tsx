import { For, createEffect } from 'solid-js';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A native select whose shown choice always matches `value`. Setting a select's value before its
 * options exist (async lists) silently falls back to the first option; this re-applies it after
 * the options render and whenever value or options change, and after a choice the owner didn't take.
 */
export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  class?: string;
  disabled?: boolean;
  label?: string;
}) {
  let el!: HTMLSelectElement;
  // User effects run after the options are inserted.
  createEffect(() => {
    void props.options;
    el.value = props.value;
  });
  return (
    <select
      ref={el}
      id={props.id}
      class={props.class}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={(e) => {
        props.onChange(e.currentTarget.value);
        el.value = props.value; // unchanged when the owner refused the choice
      }}
    >
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}
