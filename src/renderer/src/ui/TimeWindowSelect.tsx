// The time window picker of filter bars and headers: Any, short presets back from now, a set range, or a custom range in a popover.
import { Show, createSignal, createUniqueId } from 'solid-js';
import { MS_PER_DAY } from '@shared/units';
import { localRange, toLocalInput } from './format';
import { keepOnScreen } from './keepOnScreen';
import { onPointerDownOutside } from './listen';
import { HeaderButton } from './PanelHeader';
import { Select } from './Select';
import { TIME_PRESETS, isTimeRange, timeBounds, timeRangeLabel, type TimePreset, type TimeWindow } from './timeWindow';
import styles from './TimeWindowSelect.module.css';

export interface TimeWindowSelectProps {
  /** Null: any time. */
  window: TimeWindow | null;
  onChange(window: TimeWindow | null): void;
  /** Names the picker, e.g. "Alerts time frame". */
  label: string;
  /** The presets offered, as `{ last: id }`; the standard ones (24h, 7d, 30d) when absent. */
  presets?: readonly TimePreset[];
  /** Offers Any (null); on unless false. */
  anyTime?: boolean;
  disabled?: boolean;
  /** The select's id, for a label's `for`. */
  id?: string;
  /** Sizes the select. */
  class?: string;
}

const ANY = 'any';
const RANGE = 'range';
const CUSTOM = 'custom';
const PRESET = 'last:';
/** A new custom range starts as the last week, the commonest span asked about. */
const CUSTOM_START_MS = 7 * MS_PER_DAY;

export function TimeWindowSelect(props: TimeWindowSelectProps) {
  const uid = createUniqueId();
  const [custom, setCustom] = createSignal<{ from: string; to: string } | null>(null);
  let root!: HTMLSpanElement;
  const select = (): HTMLSelectElement | null => root.querySelector('select');
  let pop: HTMLDivElement | undefined;
  const presets = (): readonly TimePreset[] => props.presets ?? TIME_PRESETS;
  const range = () => (props.window && isTimeRange(props.window) && (props.window.since !== null || props.window.until !== null) ? props.window : null);
  const value = (): string => {
    const w = props.window;
    if (!w) return ANY;
    return isTimeRange(w) ? (range() ? RANGE : ANY) : `${PRESET}${w.last}`;
  };
  const options = () => [
    ...(range() ? [{ value: RANGE, label: timeRangeLabel(range()!) }] : []),
    ...(props.anyTime === false ? [] : [{ value: ANY, label: 'Any' }]),
    ...presets().map((p) => ({ value: `${PRESET}${p.id}`, label: p.label })),
    { value: CUSTOM, label: 'Custom…' },
  ];
  const close = (): void => {
    setCustom(null);
    select()?.focus({ preventScroll: true });
  };
  const openCustom = (): void => {
    const now = Date.now();
    const shown = timeBounds(props.window, now);
    setCustom({ from: toLocalInput(shown.since ?? now - CUSTOM_START_MS), to: toLocalInput(shown.until ?? now) });
    queueMicrotask(() => {
      const anchor = select();
      if (!pop?.isConnected || !anchor) return;
      pop.showPopover();
      const r = anchor.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(pop).getPropertyValue('--cp-popover-gap')) || 0;
      keepOnScreen(pop, r.left, r.bottom + gap, { x: r.right, y: r.top - gap });
      pop.querySelector('input')?.focus({ preventScroll: true });
    });
  };
  const choose = (v: string): void => {
    if (v === CUSTOM) return openCustom();
    setCustom(null);
    if (v === ANY) props.onChange(null);
    else if (v.startsWith(PRESET)) props.onChange({ last: v.slice(PRESET.length) });
  };
  const picked = () => { const c = custom(); return c ? localRange(c.from, c.to) : null; };
  const apply = (): void => {
    const r = picked();
    if (!r) return;
    props.onChange({ since: r.fromTs, until: r.toTs });
    close();
  };
  onPointerDownOutside(() => root, () => custom() !== null, () => setCustom(null));
  return (
    <span class={styles.root} ref={root}>
      <Select id={props.id} label={props.label} class={props.class} value={value()} options={options()} disabled={props.disabled}
        onChange={choose} />
      <Show when={custom()}>{(c) => (
        // Escape closes this alone, not a popover or sheet it opened from.
        <div ref={pop} id={`${uid}-custom`} popover="manual" role="dialog" aria-label={`${props.label}: custom range`} class={`cp-popover ${styles.popover}`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
          <input type="datetime-local" class={styles.dateInput} aria-label="From" value={c().from}
            onInput={(e) => setCustom({ ...c(), from: e.currentTarget.value })} />
          <input type="datetime-local" class={styles.dateInput} aria-label="To" value={c().to}
            onInput={(e) => setCustom({ ...c(), to: e.currentTarget.value })} />
          <HeaderButton variant="primary" disabled={!picked()} onClick={apply}>Apply</HeaderButton>
          <HeaderButton onClick={close}>Cancel</HeaderButton>
        </div>
      )}</Show>
    </span>
  );
}
