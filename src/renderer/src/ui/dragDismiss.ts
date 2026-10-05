// Drag down to dismiss (the image viewer, the phone's sheets), DOM-free: how far a drag pulls, and whether letting go dismisses.

/** Dragging down at least this far, then letting go, dismisses: past a sloppy tap or pan. */
export const DISMISS_DRAG_PX = 96;

/** How far a drag of `dy` pulls down: never up. */
export const pullDown = (dy: number): number => Math.max(0, dy);

/** Letting go of a pull dismisses when it went far enough; a cancelled gesture (`released` false) never does. */
export const dismisses = (pull: number, released: boolean): boolean => released && pull >= DISMISS_DRAG_PX;
