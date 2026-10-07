// Whether the owner can look at an element: what looping media (GIFs, gifv videos, Lottie) plays by.
import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from 'solid-js';
import { inCompanion } from '@/state/ui';
import { windowCovered } from '@/state/windows';

/** The window has focus; always true on the phone, whose page is hidden while it isn't. One shared signal. */
export const windowFocused: Accessor<boolean> = inCompanion
  ? () => true
  : createRoot(() => {
      const [focused, setFocused] = createSignal(document.hasFocus());
      window.addEventListener('focus', () => setFocused(true));
      window.addEventListener('blur', () => setFocused(false));
      return focused;
    });

/** The page is visible: not minimized, in the tray, or in the background (phone). */
export const pageVisible: Accessor<boolean> = createRoot(() => {
  const [visible, setVisible] = createSignal(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', () => setVisible(document.visibilityState === 'visible'));
  return visible;
});

/** One observer for every watched element: on screen, unclipped by its scrollers, its panel shown. */
const onScreenSetters = new Map<Element, (on: boolean) => void>();
let observer: IntersectionObserver | undefined;
const watch = (el: Element, set: (on: boolean) => void): (() => void) => {
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) onScreenSetters.get(e.target)?.(e.isIntersecting);
  });
  onScreenSetters.set(el, set);
  observer.observe(el);
  return () => {
    onScreenSetters.delete(el);
    observer?.unobserve(el);
  };
};

/** `el` is on screen (any part of it). Owner-scoped. */
export function createOnScreen(el: Element): Accessor<boolean> {
  const [on, setOn] = createSignal(false);
  onCleanup(watch(el, setOn));
  return on;
}

/** The owner can look at `el`: on screen, the page visible, the window focused, and no modal (the image viewer) over it. Owner-scoped. */
export function createLooking(el: Element): Accessor<boolean> {
  const onScreen = createOnScreen(el);
  return () => onScreen() && pageVisible() && windowFocused() && (!windowCovered() || el.closest('dialog[open]') !== null);
}

/** Plays a looping video (gifv) only while the owner can look at it, stopping on the frame shown. Call from its ref. */
export function loopWhileLooking(video: HTMLVideoElement): void {
  const looking = createLooking(video);
  createEffect(() => {
    // A play() a pause() interrupts rejects; nothing to recover.
    if (looking()) void video.play().catch(() => undefined);
    else video.pause();
  });
}
