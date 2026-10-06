// The tallest of several observed boxes, for a parent keeping clear of elements that lie over its content.
import { createSignal, onCleanup } from 'solid-js';

/** Observes document-resident border-box heights, including padding changes. Returns tallest height or zero; call inside a component. */
export function createTallestBox(): { height: () => number; observe: (el: Element) => void } {
  const [height, setHeight] = createSignal(0);
  const heights = new Map<Element, number>();
  // A removed element is reported once more (at zero size): it is dropped then.
  const observer = new ResizeObserver((entries) => {
    for (const e of entries) {
      if (e.target.isConnected) heights.set(e.target, e.borderBoxSize[0]?.blockSize ?? 0);
      else {
        observer.unobserve(e.target);
        heights.delete(e.target);
      }
    }
    setHeight(Math.max(0, ...heights.values()));
  });
  onCleanup(() => observer.disconnect());
  return { height, observe: (el) => observer.observe(el, { box: 'border-box' }) };
}
