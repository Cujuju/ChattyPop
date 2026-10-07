// Pinch, wheel, drag and double-tap zoom for one image (the Lightbox's), and drag-down to dismiss it, from pointer events:
// touch and mouse alike.
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { dismisses } from './dragDismiss';
import { createDoubleTap, type Contact } from './taps';
import { FIT, panBy, pullOf, zoomAt, type Point, type Size, type Zoom } from './zoomMath';

/** Enough to read small text in a screenshot; past this, pixels only get blurrier. */
const MAX_SCALE = 6;
/** Double-tap zooms to the image's own resolution, but at least this much, so the step is always visible. */
const DOUBLE_TAP_MIN_SCALE = 2;
/** Wheel zoom per px of scroll: a 100px notch zooms ~22%. */
const WHEEL_ZOOM_PER_PX = 0.002;

export interface ZoomControls {
  zoom: Accessor<Zoom>;
  /** How far down the fitted image is being dragged to dismiss it, in px; 0 when not. */
  pull: Accessor<number>;
  /** A pinch or drag is under way: the image follows the fingers without easing. */
  gesturing: Accessor<boolean>;
  reset(): void;
  /** Attaches the gestures to the image element (call from its ref). */
  bind(img: HTMLImageElement): void;
}

/** `onDismiss`: the fitted image was dragged down far enough and let go. */
export function createZoom(onDismiss: () => void): ZoomControls {
  const [zoom, setZoom] = createSignal<Zoom>(FIT);
  const [pull, setPull] = createSignal(0);
  const [gesturing, setGesturing] = createSignal(false);
  let img: HTMLImageElement | undefined;
  const pointers = new Map<number, Point>();
  let start: { zoom: Zoom; points: Point[] } | null = null;
  const taps = createDoubleTap();
  const contact = (e: PointerEvent): Contact => ({ at: e.timeStamp, x: e.clientX, y: e.clientY });

  const box = (): Size => ({ w: img!.offsetWidth, h: img!.offsetHeight });
  /** A client point relative to the image's fitted (untransformed) box. */
  const local = (p: Point): Point => {
    const r = img!.getBoundingClientRect();
    const z = zoom();
    return { x: p.x - (r.left - z.x), y: p.y - (r.top - z.y) };
  };
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
  const begin = (): void => {
    start = { zoom: zoom(), points: [...pointers.values()] };
  };

  const toggle = (p: Point): void => {
    if (zoom().scale > 1) return void setZoom(FIT);
    const own = img!.naturalWidth / img!.offsetWidth;
    setZoom(zoomAt(FIT, Math.max(DOUBLE_TAP_MIN_SCALE, own), local(p), box(), MAX_SCALE));
  };

  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return; // a right-click opens the menu, not a drag
    img!.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setGesturing(true);
    // A second finger makes it a pinch, never a tap.
    if (pointers.size === 1) taps.down(contact(e));
    else taps.cancel();
    begin();
  };
  const move = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = [...pointers.values()];
    if (now.length >= 2 && start.points.length >= 2) {
      const [a0, b0] = start.points as [Point, Point];
      const [a, b] = now as [Point, Point];
      const m0 = mid(a0, b0);
      const m = mid(a, b);
      // Zoom about where the pinch started, then follow the fingers' midpoint.
      const scaled = zoomAt(start.zoom, dist(a, b) / dist(a0, b0), local(m0), box(), MAX_SCALE);
      setZoom(panBy(scaled, m.x - m0.x, m.y - m0.y, box()));
      setPull(0);
    } else if (now.length === 1) {
      const p0 = start.points[0]!;
      const p = now[0]!;
      taps.move(contact(e));
      // Zoomed, a drag pans; fitted, a drag down pulls the image away to dismiss it.
      if (start.zoom.scale > 1) setZoom(panBy(start.zoom, p.x - p0.x, p.y - p0.y, box()));
      setPull(pullOf(start.zoom, p.y - p0.y));
    }
  };
  const up = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) return begin(); // a finger lifted mid-pinch: the rest carry on from here
    setGesturing(false);
    start = null;
    const pulled = pull();
    setPull(0); // short of dismissing, the image eases back
    if (dismisses(pulled, e.type === 'pointerup')) return onDismiss();
    if (e.type !== 'pointerup') return taps.cancel();
    if (taps.up(contact(e))) toggle({ x: e.clientX, y: e.clientY });
  };
  const wheel = (e: WheelEvent): void => {
    e.preventDefault();
    setZoom(zoomAt(zoom(), Math.exp(-e.deltaY * WHEEL_ZOOM_PER_PX), local({ x: e.clientX, y: e.clientY }), box(), MAX_SCALE));
  };

  const bind = (el: HTMLImageElement): void => {
    img = el;
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    // Not passive: the wheel zooms the image instead of scrolling behind the viewer.
    el.addEventListener('wheel', wheel, { passive: false });
    onCleanup(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    });
  };
  const reset = (): void => {
    pointers.clear();
    start = null;
    taps.cancel();
    setGesturing(false);
    setPull(0);
    setZoom(FIT);
  };
  return { zoom, pull, gesturing, reset, bind };
}
