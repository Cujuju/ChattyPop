// DOM-free tap recognition: what counts as a tap, and when two taps make a double tap.

/** A still press held this long opens the menu: iOS's own long-press default (UILongPressGestureRecognizer). */
export const LONG_PRESS_MS = 500;
/** A finger drifting this far is moving, not pressing: about Android's touch slop (8dp). */
export const TOUCH_SLOP_PX = 10;
/** A second press this soon after the first tap lifts makes a double tap: Android's ViewConfiguration DOUBLE_TAP_TIMEOUT. */
export const DOUBLE_TAP_MS = 300;
/** The second press lands this close to the first: about a fingertip's width. */
export const DOUBLE_TAP_SLOP_PX = 24;

/** One finger's position at a moment (event timeStamp, client px). */
export interface Contact {
  at: number;
  x: number;
  y: number;
}

export interface DoubleTap {
  down(c: Contact): void;
  move(c: Contact): void;
  /** Whether this lift completes a double tap. */
  up(c: Contact): boolean;
  /** Forgets the press and any first tap: a second finger, a cancelled touch. */
  cancel(): void;
}

const dist = (a: Contact, b: Contact): number => Math.hypot(a.x - b.x, a.y - b.y);

/** A tap is a press shorter than a long press that never drifts past the slop; timing and slop follow Android's GestureDetector. */
export function createDoubleTap(): DoubleTap {
  let press: (Contact & { second: boolean }) | null = null;
  /** The first tap: when it lifted, where it pressed. */
  let first: Contact | null = null;
  const cancel = (): void => {
    press = first = null;
  };
  return {
    down(c) {
      const second = first !== null && c.at - first.at <= DOUBLE_TAP_MS && dist(c, first) <= DOUBLE_TAP_SLOP_PX;
      if (!second) first = null;
      press = { ...c, second };
    },
    move(c) {
      if (press && dist(c, press) > TOUCH_SLOP_PX) cancel();
    },
    up(c) {
      const p = press;
      press = null;
      const tapped = p !== null && c.at - p.at < LONG_PRESS_MS && dist(c, p) <= TOUCH_SLOP_PX;
      if (!tapped || p.second) {
        cancel();
        return tapped;
      }
      first = { at: c.at, x: p.x, y: p.y };
      return false;
    },
    cancel,
  };
}
