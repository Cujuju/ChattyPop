import { Show, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { inCompanion } from '@/state/ui';
import { look } from '@/theme/look';
import { Icon } from './icons';
import { keepOnScreen } from './keepOnScreen';
import { listen, onPointerDownOutside } from './listen';
import { SearchList, groupsOf, type SearchListHandle } from './SearchList';
import type { SelectOption } from './Select';
import styles from './SearchSelect.module.css';

/** A choice; options may form a tree one level deep. */
export interface SearchOption extends SelectOption {
  /** Listed under the nearest top-level option; filtering by its parent's label also finds it. */
  nested?: boolean;
  /** A long tail listed while filtering, or once its group's "more" row is opened. */
  searchOnly?: boolean;
  /** Drawn before the label, in the list and on the trigger. */
  lead?: () => JSX.Element;
}

/** Desktop floating picker; companion full-screen picker. Both use the same searchable list. */
export function SearchSelect(props: {
  id?: string;
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  class?: string;
  placeholder?: string;
  /** Names the mobile page and trigger. */
  label?: string;
  /** Accessible name of the search input. */
  searchLabel?: string;
}) {
  const uid = createUniqueId();
  const pageId = `${uid}-page`;
  const listId = `${uid}-list`;
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let pop: HTMLDivElement | undefined;
  let dialog: HTMLDialogElement | undefined;
  let list: SearchListHandle | undefined;
  let alive = true;
  onCleanup(() => { alive = false; list = undefined; });
  const options = createMemo(() => props.options);
  const current = () => options().find((o) => o.value === props.value);
  const label = () => props.label ?? 'Choose an option';
  const path = (): string | undefined => {
    const o = current();
    const parent = o?.nested ? groupsOf(options()).find((g) => g.kids.includes(o))?.head : undefined;
    return parent && `${parent.label} › ${o!.label}`;
  };
  const close = (): void => {
    setOpen(false);
    trigger.focus({ preventScroll: true });
  };
  const place = (): void => {
    if (!pop?.isConnected || inCompanion) return;
    const r = trigger.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(pop).getPropertyValue('--cp-popover-gap')) || 0;
    pop.style.minWidth = `${Math.max(r.width, pop.getBoundingClientRect().width)}px`;
    keepOnScreen(pop, r.left, r.bottom + gap, { x: r.right, y: r.top - gap });
  };
  const show = (): void => {
    if (props.disabled) return;
    setOpen(true);
    queueMicrotask(() => {
      if (!alive || !open()) return;
      if (inCompanion) dialog?.showModal();
      else {
        pop?.showPopover();
        place();
        list?.focusSearch();
      }
      list?.scrollCurrent();
    });
  };
  // Outside presses retain their destination focus; explicit dismissal restores the picker trigger.
  onPointerDownOutside(() => root, () => open() && !inCompanion, () => setOpen(false));
  listen(window, 'resize', () => open() && place());
  listen(window, 'scroll', (e) => open() && !pop?.contains(e.target as Node) && place(), { capture: true, passive: true });
  const content = () => (
    <SearchList id={listId} value={props.value} options={options()} label={label()}
      searchLabel={props.searchLabel ?? `Filter ${label().toLowerCase()}`}
      onReady={(handle) => { list = handle; }} onLayout={place} onClose={close}
      onPick={(value) => { props.onChange(value); close(); }} />
  );
  return (
    <div class={`${styles.root} ${props.class ?? ''}`} ref={root}>
      <button
        ref={trigger} type="button" id={props.id} class={styles.trigger}
        disabled={props.disabled} title={path()}
        aria-label={props.label ? `${props.label}: ${current()?.label ?? (props.value || props.placeholder || '')}` : undefined}
        aria-haspopup={inCompanion ? 'dialog' : 'listbox'} aria-expanded={open()}
        aria-controls={open() ? (inCompanion ? pageId : listId) : undefined}
        data-mobile={inCompanion} onClick={() => (open() ? close() : show())}
      >
        <Show when={current()?.lead}>{(draw) => <span class={styles.lead} aria-hidden="true">{draw()()}</span>}</Show>
        <span class={styles.value}>{current()?.label ?? (props.value || props.placeholder)}</span>
        <Show when={inCompanion} fallback={<span class="cp-chevron" aria-hidden="true" />}>
          <Icon name="chevronRight" class={styles.disclosure} />
        </Show>
      </button>
      <Show when={open()}>
        <Show when={inCompanion} fallback={
          <div ref={pop} popover="manual" class={`cp-popover ${styles.popover}`}>{content()}</div>
        }>
          <Portal>
            <dialog ref={dialog} id={pageId} class={`${styles.page} ${look.page}`}
              aria-labelledby={`${pageId}-title`}
              onCancel={(e) => { e.preventDefault(); e.stopPropagation(); close(); }} onClose={close}>
              <header class={`${styles.pageHeader} ${look.chrome} ${look.ruleBelow}`}>
                <button type="button" class={`${styles.pageBack} ${look.iconButton}`} aria-label={`Back from ${label()}`} onClick={close}>
                  <Icon name="arrowLeft" />
                </button>
                <h2 id={`${pageId}-title`} class={`${styles.pageTitle} ${look.text}`} data-size="lg" data-weight="semibold">{label()}</h2>
              </header>
              <div class={`${styles.pageBody} ${look.silentFocus}`} tabIndex={-1} autofocus onKeyDown={(e) => list?.onKey(e)}>{content()}</div>
            </dialog>
          </Portal>
        </Show>
      </Show>
    </div>
  );
}
