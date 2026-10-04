// The tallest of several observed boxes, for a parent keeping clear of elements that lie over its content.
import { createSignal, onCleanup } from 'solid-js';

/**
 * Observes each element given to `observe` (its border box: padding changes alone, as a phone's home-bar inset, count)
 * until it leaves the document. `height` is the tallest one's, zero with none. Call inside a component.
 */
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
