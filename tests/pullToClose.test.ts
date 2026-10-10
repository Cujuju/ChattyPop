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

/** A touch event as the screen reports it: a lifted finger is in no touchend's `touches`; `others` are fingers elsewhere on the screen. */
const touchOn = (target: EventTarget) => (type: string, y: number, others = 0) => {
  const own = type === 'touchend' ? [] : [{ clientY: y }];
  const e = Object.assign(new Event(type, { cancelable: true }), { touches: [...own, ...Array.from({ length: others }, () => ({ clientY: 0 }))] });
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

/** An expanded two-height sheet: a pull down lowers it to its first height. */
function expandedSheet() {
  const sheet = fakeSheet();
  const close = vi.fn();
  const setExpanded = vi.fn();
  createRoot(() => pullToClose(sheet, close, sheet, { expanded: () => true, setExpanded }));
  return { sheet, close, setExpanded, touch: touchOn(sheet) };
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

  it('shrinks an expanded sheet under the finger, never moving it, and lowers it on release', () => {
    const { sheet, close, setExpanded, touch } = expandedSheet();
    touch('touchstart', 300);
    expect(touch('touchmove', 450)).toBe(true);
    expect(sheet.style.height).toBe(`${SHEET_PX - 150}px`);
    expect(sheet.style.translate).toBe('');
    touch('touchend', 450);
    expect(setExpanded).toHaveBeenCalledWith(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('ends the pull when a second finger lands off the grip, closing nothing', () => {
    const sheet = fakeSheet();
    const close = vi.fn();
    createRoot(() => pullToClose(sheet, close));
    const touch = touchOn(sheet);
    touch('touchstart', 300);
    touch('touchmove', 300 + SHEET_PX / 2);
    touch('touchmove', 300 + SHEET_PX / 2, 1);
    expect(sheet.dataset['pull']).toBeUndefined();
    touch('touchend', 300 + SHEET_PX / 2, 1);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes nothing when the pulling finger lifts while another rests on the screen', () => {
    const sheet = fakeSheet();
    const close = vi.fn();
    createRoot(() => pullToClose(sheet, close));
    const touch = touchOn(sheet);
    touch('touchstart', 300);
    touch('touchmove', 300 + SHEET_PX / 2);
    touch('touchend', 300 + SHEET_PX / 2, 1);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a sheet pulled down past its share and let go', () => {
    const sheet = fakeSheet();
    const close = vi.fn();
    createRoot(() => pullToClose(sheet, close));
    const touch = touchOn(sheet);
    touch('touchstart', 300);
    touch('touchmove', 300 + SHEET_PX / 2);
    touch('touchend', 300 + SHEET_PX / 2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves an expanded sheet expanded after a short pull', () => {
    const { setExpanded, touch } = expandedSheet();
    touch('touchstart', 300);
    touch('touchmove', 350);
    touch('touchend', 350);
    expect(setExpanded).not.toHaveBeenCalled();
  });
});
