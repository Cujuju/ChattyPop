// A tap on a phone sheet stays a tap: a finger's few-pixel wobble must not start a pull, whose prevented touchmove would
// cancel the tap's click (the attach sheet's buttons then took two taps).
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('../src/renderer/src/ui/scrollEdges', () => ({ scrolledFromTop: () => 0 }));
const { createRoot } = await import('solid-js');
// A variable path keeps the renderer module out of the node type-check.
const pullPath = '../src/renderer/src/ui/pullToClose';
const { pullToClose } = (await import(pullPath)) as {
  pullToClose(sheet: unknown, close: () => void, scroller?: unknown, expand?: { expanded: () => boolean; setExpanded: (on: boolean) => void }): void;
};

const SHEET_PX = 400;
(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ maxHeight: `${SHEET_PX * 2}px` });

/** A sheet that can rise (two heights, not expanded): any upward move could start a pull. */
function risingSheet() {
  const sheet = Object.assign(new EventTarget(), { dataset: {} as Record<string, string>, style: { translate: '', height: '', removeProperty: () => undefined }, offsetHeight: SHEET_PX });
  createRoot(() => pullToClose(sheet, () => undefined, sheet, { expanded: () => false, setExpanded: () => undefined }));
  const touch = (type: string, y: number) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { touches: [{ clientY: y }] });
    sheet.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { sheet, touch };
}

describe('pullToClose', () => {
  it('leaves a tap’s wobble alone, so the click still fires', () => {
    const { sheet, touch } = risingSheet();
    touch('touchstart', 300);
    expect(touch('touchmove', 299)).toBe(false);
    expect(touch('touchmove', 304)).toBe(false);
    expect(sheet.dataset['pull']).toBeUndefined();
  });

  it('takes a real pull once the finger travels past the slop', () => {
    const { sheet, touch } = risingSheet();
    touch('touchstart', 300);
    expect(touch('touchmove', 260)).toBe(true);
    expect(sheet.dataset['pull']).toBe('true');
  });
});
