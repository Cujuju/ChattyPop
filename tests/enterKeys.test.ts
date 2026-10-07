// Enter in a field with a suggestion list: picking never lets the key through to send, and a held Enter sends once.
import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/state/ui', () => ({ inCompanion: false }));

/** The key event fields both handlers read. */
interface Key {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  preventDefault: Mock;
  stopPropagation: Mock;
}
// Renderer modules: imported by path so the node type-check doesn't follow them into DOM types.
const listNavPath = '../src/renderer/src/ui/listNav';
const enterPath = '../src/renderer/src/ui/enterToSend';
const { createListNav } = (await import(listNavPath)) as {
  createListNav(count: () => number, opts: { onEnter: (i: number) => void; onEscape: () => void; activeEl: () => null }): { onKey(e: Key): void };
};
const { enterToSend } = (await import(enterPath)) as { enterToSend(send: () => void): { onKeyDown(e: Key): boolean } };

const key = (k: string, more: Partial<Key> = {}): Key => ({ key: k, shiftKey: false, isComposing: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...more });

describe('list navigation', () => {
  it('holds back Enter’s default before picking, so a pick that throws still inserts no newline', () => {
    const nav = createListNav(() => 1, {
      onEnter: () => {
        throw new Error('pick failed');
      },
      onEscape: () => undefined,
      activeEl: () => null,
    });
    const e = key('Enter');
    expect(() => nav.onKey(e)).toThrow('pick failed');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('leaves arrows alone while the list is empty, and other keys always', () => {
    const nav = createListNav(() => 0, { onEnter: () => undefined, onEscape: () => undefined, activeEl: () => null });
    for (const k of ['ArrowDown', 'a']) {
      const e = key(k);
      nav.onKey(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('enter to send', () => {
  it('sends on Enter, not on its repeats: a held Enter that picked a suggestion sends nothing', () => {
    const send = vi.fn();
    const enter = enterToSend(send);
    const repeat = key('Enter', { repeat: true });
    expect(enter.onKeyDown(repeat)).toBe(true);
    expect(repeat.preventDefault).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    enter.onKeyDown(key('Enter'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
