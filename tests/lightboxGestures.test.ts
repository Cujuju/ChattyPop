import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
const zoomPath = '../src/renderer/src/ui/createZoom';
const { createZoom } = await import(zoomPath) as {
  createZoom(dismiss: () => void, swipe: (direction: -1 | 1) => void): { bind(img: unknown): void; reset(): void; zoom(): { scale: number } };
};

function harness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const swipe = vi.fn(); const dismiss = vi.fn();
  const root = createRoot((dispose) => {
    const zoom = createZoom(dismiss, swipe);
    zoom.bind({ offsetWidth: 100, offsetHeight: 100, naturalWidth: 400,
      getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
      removeEventListener: () => undefined });
    return { zoom, dispose };
  });
  return { ...root, swipe, dismiss,
    fire(type: string, x: number, y = 0, pointerId = 1): void {
      listeners.get(type)!({ type, button: 0, clientX: x, clientY: y, pointerId, timeStamp: 0, preventDefault: () => undefined });
    } };
}

describe('gallery swipes and zoom reset', () => {
  it('steps fitted images in both directions and ignores short or cancelled swipes', () => {
    const h = harness();
    try {
      h.fire('pointerdown', 100); h.fire('pointerup', 20);
      h.fire('pointerdown', 0); h.fire('pointerup', 80);
      expect(h.swipe.mock.calls).toEqual([[1], [-1]]);
      h.fire('pointerdown', 0); h.fire('pointerup', 40);
      h.fire('pointerdown', 0); h.fire('pointercancel', 100);
      expect(h.swipe).toHaveBeenCalledTimes(2);
      expect(h.dismiss).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });
  it('keeps vertical dismiss separate and never turns a pinch or zoomed pan into navigation', () => {
    const h = harness();
    try {
      h.fire('pointerdown', 0); h.fire('pointermove', 10, 200); h.fire('pointerup', 10, 200);
      expect(h.dismiss).toHaveBeenCalledOnce();
      h.fire('pointerdown', 0); h.fire('pointerdown', 100, 0, 2);
      h.fire('pointermove', 200, 0, 2); h.fire('pointerup', 200, 0, 2); h.fire('pointerup', -100);
      expect(h.zoom.zoom().scale).toBeGreaterThan(1);
      h.fire('pointerdown', 0); h.fire('pointerup', -100);
      expect(h.swipe).not.toHaveBeenCalled();
      h.zoom.reset();
      expect(h.zoom.zoom().scale).toBe(1);
      h.fire('pointerdown', 100); h.fire('pointerup', 0);
      expect(h.swipe).toHaveBeenCalledWith(1);
    } finally { h.dispose(); }
  });
});
