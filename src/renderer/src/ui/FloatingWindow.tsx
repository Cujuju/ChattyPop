import { For, createEffect, on, onCleanup, type JSX } from 'solid-js';
import { saveWindow, savedWindows, trackWindow, untrackWindow, windowRank, type WindowRect } from '@/state/windows';
import { listen } from './listen';
import { WINDOW_EDGES, resizeRect, type WindowEdge } from './windowResize';
import { Icon } from './icons';
import styles from './FloatingWindow.module.css';

interface Props {
  /** Key its geometry is remembered under. */
  id: string;
  open: boolean;
  onClose: () => void;
  /** Surface class: background, border, header and body styles. */
  class: string | undefined;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  children: JSX.Element;
}

/** No larger than the viewport and fully inside it, so the header can always be grabbed. */
function clampToViewport(r: WindowRect): WindowRect {
  const width = Math.min(r.width, innerWidth);
  const height = Math.min(r.height, innerHeight);
  return { width, height, x: Math.min(Math.max(r.x, 0), innerWidth - width), y: Math.min(Math.max(r.y, 0), innerHeight - height) };
}

/** Controls inside the header that take clicks instead of starting a drag. */
const INTERACTIVE = 'button, a, input, select, textarea';

/**
 * A non-modal window (native <dialog> opened with show()): no backdrop, the app stays usable behind it. Dragged by its
 * first <header>, resized from any edge or corner, raised on click, closed by Esc; its last position and size are restored.
 */
export function FloatingWindow(props: Props) {
  let el!: HTMLDialogElement;
  const rect = (): WindowRect => {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  };
  const apply = (r: WindowRect): void => {
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    trackWindow(props.id, r);
  };
  // First open: the surface class's own size, centred.
  const centred = (): WindowRect => {
    const b = el.getBoundingClientRect();
    return { x: (innerWidth - b.width) / 2, y: (innerHeight - b.height) / 2, width: b.width, height: b.height };
  };
  const remember = (): void => saveWindow(props.id, rect());

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open && !el.open) {
          el.show();
          trackWindow(props.id, rect(), true);
          apply(clampToViewport(savedWindows()[props.id] ?? centred()));
        } else if (!open && el.open) {
          remember();
          el.close();
        }
      },
    ),
  );

  const onPointerDown = (e: PointerEvent): void => {
    trackWindow(props.id, rect(), true);
    const target = e.target as Element;
    const header = target.closest('header');
    if (e.button !== 0 || header?.parentElement !== el || target.closest(INTERACTIVE)) return;
    e.preventDefault();
    const start = rect();
    const grabX = e.clientX - start.x;
    const grabY = e.clientY - start.y;
    header.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent): void => apply(clampToViewport({ ...start, x: m.clientX - grabX, y: m.clientY - grabY }));
    const end = (): void => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', end);
      header.removeEventListener('pointercancel', end);
      remember();
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  };

  /** Edge or corner drag: the opposite side stays put; min size comes from the surface's CSS (Settings sets a wider one). */
  const onGripDown = (e: PointerEvent, edge: WindowEdge): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const start = rect();
    const css = getComputedStyle(el);
    const min = { width: parseFloat(css.minWidth) || 0, height: parseFloat(css.minHeight) || 0 };
    grip.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent): void => apply(resizeRect(start, edge, m.clientX - e.clientX, m.clientY - e.clientY, min, { width: innerWidth, height: innerHeight }));
    const end = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      remember();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };
  // A smaller app window pulls open windows back inside it.
  const onViewportResize = (): void => {
    if (el.open) apply(clampToViewport(rect()));
  };
  listen(window, 'resize', onViewportResize);
  onCleanup(() => untrackWindow(props.id));

  return (
    <dialog
      ref={el}
      class={[props.class, styles.window].filter(Boolean).join(' ')}
      style={{ 'z-index': `calc(var(--cp-z-window) + ${Math.max(windowRank(props.id), 0)})` }}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        props.onClose();
      }}
      onClose={() => {
        untrackWindow(props.id);
        props.onClose();
      }}
    >
      {props.children}
      <For each={WINDOW_EDGES}>{(edge) => <div class={styles.grip} data-edge={edge} aria-hidden="true" onPointerDown={(e) => onGripDown(e, edge)} />}</For>
    </dialog>
  );
}

/** Classes from the window's surface module. */
export interface WindowHeaderClasses {
  header?: string;
  title?: string;
  close?: string;
}

/** A window's title bar with its close button. Render it as the window's first child: FloatingWindow drags by it. */
export function WindowHeader(props: {
  title: JSX.Element;
  /** For the window's aria-labelledby. */
  titleId?: string;
  classes: WindowHeaderClasses;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <header class={props.classes.header}>
      <h1 id={props.titleId} class={props.classes.title}>
        {props.title}
      </h1>
      <button type="button" class={props.classes.close} aria-label={props.closeLabel} onClick={() => props.onClose()}>
        <Icon name="close" />
      </button>
    </header>
  );
}
