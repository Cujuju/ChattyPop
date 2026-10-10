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
  pullToClose(sheet: unknown, close: () => void, scroller?: unknown, expand?: { expanded: () => boolean; setExpanded: (on: boolean) => void }, grip?: unknown): void;
};

const SHEET_PX = 400;
(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ maxHeight: `${SHEET_PX * 2}px` });

const touchOn = (target: EventTarget) => (type: string, y: number) => {
  const e = Object.assign(new Event(type, { cancelable: true }), { touches: [{ clientY: y }] });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};

const fakeSheet = () => Object.assign(new EventTarget(), { dataset: {} as Record<string, string>, style: { translate: '', height: '', removeProperty: () => undefined }, offsetHeight: SHEET_PX });

/** A sheet that can rise (two heights, not expanded): any upward move could start a pull. */
function risingSheet() {
  const sheet = fakeSheet();
  createRoot(() => pullToClose(sheet, () => undefined, sheet, { expanded: () => false, setExpanded: () => undefined }));
  return { sheet, touch: touchOn(sheet) };
}

/** A rising sheet pulled by a grip: its own target, as a child's touches would reach the sheet only by bubbling. */
function grippedSheet() {
  const sheet = fakeSheet();
  const grip = new EventTarget();
  const setExpanded = vi.fn();
  createRoot(() => pullToClose(sheet, () => undefined, grip, { expanded: () => false, setExpanded }, grip));
  return { sheet, setExpanded, onGrip: touchOn(grip), offGrip: touchOn(sheet) };
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

  it('leaves a sheet with a grip to scroll everywhere else', () => {
    const { sheet, offGrip } = grippedSheet();
    offGrip('touchstart', 300);
    expect(offGrip('touchmove', 260)).toBe(false);
    expect(sheet.dataset['pull']).toBeUndefined();
  });

  it('raises the sheet from its grip, and expands it past the pull’s share', () => {
    const { sheet, setExpanded, onGrip } = grippedSheet();
    onGrip('touchstart', 300);
    expect(onGrip('touchmove', 150)).toBe(true);
    expect(sheet.style.height).toBe(`${SHEET_PX + 150}px`);
    onGrip('touchend', 150);
    expect(setExpanded).toHaveBeenCalledWith(true);
  });
});
