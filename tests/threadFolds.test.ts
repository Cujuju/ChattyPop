// A channel's threads fold in every channel list: the gestures that fold them, and what a folded channel counts.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
// Stored settings: in memory here.
vi.mock('@plugin-sdk/renderer/settings', () => {
  const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  return { createSetting: <T>(_key: string, initial: T, normalize: (v: unknown) => T) => {
    const [value, setValue] = createSignal(initial);
    return [value, (v: T) => { setValue(() => normalize(v)); return Promise.resolve(); }];
  } };
});
vi.mock('../src/renderer/src/state/directory', () => ({
  threadsOf: (id: string) => id === 'general' ? [{ newCount: 3, mentionCount: 1 }, { newCount: 2, mentionCount: 0 }] : [],
}));

/** A node inside a row: on its chevron or not. */
class FakeElement {
  constructor(private readonly onChevron: boolean) {}
  closest(): FakeElement | null { return this.onChevron ? this : null; }
}
vi.stubGlobal('Element', FakeElement);

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/threadFolds';
const folds = (await import(statePath)) as {
  threadsShown(id: string): boolean;
  /** Takes a DOM MouseEvent or KeyboardEvent; these tests pass their fields only. */
  foldGesture(e: object, id: string): boolean;
  unseenInThreads(id: string): { newCount: number; mentionCount: number };
};

type Init = { type?: string; key?: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; chevron?: boolean };
const event = (init: Init) => {
  const e = { type: init.type ?? 'click', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init,
    target: new FakeElement(init.chevron ?? false), defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
  if (init.key === undefined) delete (e as { key?: string }).key;
  return e;
};

describe('folding a channel’s threads', () => {
  it('starts folded; Right unfolds and Left folds, and the row does nothing else with them', () => {
    expect(folds.threadsShown('general')).toBe(false);
    const right = event({ type: 'keydown', key: 'ArrowRight' });
    expect(folds.foldGesture(right, 'general')).toBe(true);
    expect(right.defaultPrevented).toBe(true);
    expect(folds.threadsShown('general')).toBe(true);
    expect(folds.foldGesture(event({ type: 'keydown', key: 'ArrowLeft' }), 'general')).toBe(true);
    expect(folds.threadsShown('general')).toBe(false);
    expect(folds.foldGesture(event({ type: 'keydown', key: 'Enter' }), 'general')).toBe(false);
    expect(folds.foldGesture(event({ type: 'keydown', key: 'ArrowLeft', altKey: true }), 'general')).toBe(false);
  });

  it('toggles on the chevron, on Alt+click and on a double-click; a plain or modified click opens instead', () => {
    expect(folds.foldGesture(event({}), 'general')).toBe(false);
    expect(folds.foldGesture(event({ ctrlKey: true, chevron: true }), 'general')).toBe(false);
    expect(folds.threadsShown('general')).toBe(false);
    expect(folds.foldGesture(event({ chevron: true }), 'general')).toBe(true);
    expect(folds.threadsShown('general')).toBe(true);
    expect(folds.foldGesture(event({ altKey: true }), 'general')).toBe(true);
    expect(folds.threadsShown('general')).toBe(false);
    expect(folds.foldGesture(event({ type: 'dblclick' }), 'general')).toBe(true);
    expect(folds.threadsShown('general')).toBe(true);
    // Its two clicks on the chevron already toggled twice.
    expect(folds.foldGesture(event({ type: 'dblclick', chevron: true }), 'general')).toBe(true);
    expect(folds.threadsShown('general')).toBe(true);
  });

  it("counts a folded channel's threads' new messages and mentions", () => {
    expect(folds.unseenInThreads('general')).toEqual({ newCount: 5, mentionCount: 1 });
    expect(folds.unseenInThreads('quiet')).toEqual({ newCount: 0, mentionCount: 0 });
  });
});
