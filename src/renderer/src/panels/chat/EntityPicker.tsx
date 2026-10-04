import { For, Show, createEffect, createResource, createSignal, createUniqueId } from 'solid-js';
import type { SelectKind } from '@shared/components';
import { searchEntities, type EntityChoice } from '@/state/commands';
import { onPointerDownOutside } from '@/ui/listen';
import { createListNav } from '@/ui/listNav';
import { clipBounds } from '@/ui/scrollEdges';
import { Icon } from '@/ui/icons';
import styles from './EntityPicker.module.css';

const PLACEHOLDERS: Record<Exclude<SelectKind, 'string'>, string> = {
  user: 'Find a person',
  role: 'Find a role',
  mentionable: 'Find a person or role',
  channel: 'Find a channel',
};

/**
 * Picks people, roles or channels of a server by name: chosen ones show as chips, typing lists matches (arrows, Enter,
 * Escape). Up to `max` can be chosen; with one, a new pick replaces the old.
 */
export function EntityPicker(props: {
  kind: Exclude<SelectKind, 'string'>;
  guildId: string;
  channelTypes?: number[];
  max: number;
  chosen: EntityChoice[];
  onChange: (chosen: EntityChoice[]) => void;
  disabled?: boolean;
  autofocus?: boolean;
}) {
  let root!: HTMLDivElement;
  const listId = createUniqueId();
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [below, setBelow] = createSignal(false);
  const [found] = createResource(
    () => (open() ? { q: query() } : null),
    async ({ q }) => ({ q, list: await searchEntities(props.kind, props.guildId, q, props.channelTypes) }),
  );
  // Only results for what is typed now: an earlier query's must not be pickable while the new one loads.
  const current = (): EntityChoice[] => (!found.error && found.latest?.q === query() ? found.latest.list : []);
  const matches = (): EntityChoice[] => current().filter((c) => !props.chosen.some((x) => x.id === c.id));
  // Open on the side with more room inside the clipping log, so the list is never cut off.
  createEffect(() => {
    if (!open()) return;
    const r = root.getBoundingClientRect();
    const b = clipBounds(root);
    setBelow(b.bottom - r.bottom > r.top - b.top);
  });

  const pick = (c: EntityChoice | undefined): void => {
    if (!c) return;
    const next = props.max === 1 ? [c] : [...props.chosen, c].slice(0, props.max);
    props.onChange(next);
    setQuery('');
    if (next.length >= props.max) setOpen(false);
  };
  const { active, setActive, onKey } = createListNav(() => matches().length, {
    onEnter: (i) => pick(matches()[i]),
    onEscape: () => setOpen(false),
    activeEl: () => root.querySelector('[aria-selected="true"]'),
    stopPropagation: true,
  });
  onPointerDownOutside(() => root, open, () => setOpen(false));

  return (
    <div ref={root} class={styles.root}>
      <div class={styles.field} data-disabled={props.disabled === true}>
        <For each={props.chosen}>
          {(c) => (
            <span class={styles.chip} data-kind={c.kind}>
              {c.label}
              <button type="button" class={styles.chipRemove} aria-label={`Remove ${c.label}`} disabled={props.disabled} onClick={() => props.onChange(props.chosen.filter((x) => x.id !== c.id))}>
                <Icon name="close" />
              </button>
            </span>
          )}
        </For>
        <input
          class={styles.input}
          type="text"
          role="combobox"
          aria-label={PLACEHOLDERS[props.kind]}
          aria-autocomplete="list"
          aria-expanded={open()}
          aria-controls={listId}
          aria-activedescendant={open() && matches().length ? `${listId}-${active()}` : undefined}
          autocomplete="off"
          placeholder={props.chosen.length ? '' : PLACEHOLDERS[props.kind]}
          value={query()}
          disabled={props.disabled}
          autofocus={props.autofocus}
          onFocus={() => setOpen(true)}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query() && props.chosen.length) props.onChange(props.chosen.slice(0, -1));
            else if (open()) onKey(e);
          }}
        />
      </div>
      <Show when={open() && (matches().length || query())}>
        <ul id={listId} class={`cp-popover ${styles.list}`} role="listbox" data-below={below()}>
          <Show when={matches().length} fallback={<li class={styles.empty}>{!found.error && (found.loading || found.latest?.q !== query()) ? 'Searching…' : 'No matches'}</li>}>
            <For each={matches()}>
              {(c, i) => (
                <li
                  id={`${listId}-${i()}`}
                  class={styles.option}
                  role="option"
                  aria-selected={active() === i()}
                  onMouseEnter={() => setActive(i())}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c);
                  }}
                >
                  <span class={styles.optionLabel}>{c.label}</span>
                  <Show when={c.hint}>{(h) => <span class={styles.optionHint}>{h()}</span>}</Show>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
    </div>
  );
}
