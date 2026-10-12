// An icon button that acts only after a full hold: the hold is the confirmation, and a line traces the button's edge while it runs.
import { Show } from 'solid-js';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import { Icon } from './icons';
import type { IconName } from './iconNames';
import styles from './HoldButton.module.css';

/** How long the button is held before it acts: long enough that a stray click never does. */
export const HOLD_TO_CONFIRM_MS = 1_000;

/** A short click is inert; a full hold runs `onComplete`. Space or Enter held does the same. */
export function HoldButton(props: {
  icon: IconName;
  /** What a hold does, completing "Hold to …" (remove this account). */
  action: string;
  disabled?: boolean;
  onComplete: () => void;
}) {
  let button: HTMLButtonElement | undefined;
  const hold = useHoldAction({ durationMs: HOLD_TO_CONFIRM_MS, enabled: () => !props.disabled, onComplete: () => props.onComplete() });
  const label = (): string => `Hold to ${props.action}`;
  return (
    <button
      ref={button}
      type="button"
      class={`cp-button ${styles.button}`}
      data-holding={hold.holding()}
      disabled={props.disabled}
      title={label()}
      aria-label={label()}
      {...hold.handlers}
      onPointerCancel={hold.cancel}
      onBlur={hold.cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        hold.shouldSuppressClick();
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hold.cancel();
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        if (!e.repeat) hold.handlers.onPointerDown(new PointerEvent('pointerdown', { button: 0 }));
      }}
      onKeyUp={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        hold.cancel();
      }}
    >
      <Icon name={props.icon} class={styles.icon} />
      <Show when={hold.holding()}>
        <HoldIndicator progress={hold.progress} shape="rect" strokePlacement="outside" radius={parseFloat(getComputedStyle(button!).borderTopLeftRadius)} />
      </Show>
    </button>
  );
}
