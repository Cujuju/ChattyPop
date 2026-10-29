import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot } = await import('solid-js');
const path = '../src/renderer/src/ui/scrollIntent';
const { onUserScroll, onUserScrollNewer } = await import(path) as {
  onUserScroll(el: unknown, fn: () => void): void;
  onUserScrollNewer(el: unknown, fn: () => void): void;
};
let dispose: () => void;
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); });
function log(newer = false) {
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('getComputedStyle', () => ({ flexDirection: 'column' }));
  const el = Object.assign(new EventTarget(), { clientWidth: 400, clientHeight: 400, scrollHeight: 1000, scrollTop: 300 });
  const act = vi.fn();
  createRoot((stop) => { dispose = stop; (newer ? onUserScrollNewer : onUserScroll)(el, act); });
  const send = (type: string, props = {}) => el.dispatchEvent(Object.assign(new Event(type), props));
  return { el, act, send };
}
describe('chat scroll intent', () => {
  it('accepts wheel gestures in either direction including edge attempts', () => {
    const { act, send } = log();
    send('wheel', { deltaY: -1 });
    send('wheel', { deltaY: 1 });
    send('wheel', { deltaY: 0 });
    expect(act).toHaveBeenCalledTimes(2);
  });
  it('accepts scroll keys in either direction and shift-space', () => {
    const { act, send } = log();
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) send('keydown', { key });
    send('keydown', { key: ' ', shiftKey: true });
    send('keydown', { key: 'a' });
    expect(act).toHaveBeenCalledTimes(8);
  });
  it('accepts touch drags in either direction but not touch presses', () => {
    const { act, send } = log();
    send('touchstart', { touches: [{ clientY: 10 }] });
    expect(act).not.toHaveBeenCalled();
    send('touchmove', { touches: [{ clientY: 20 }] });
    send('touchmove', { touches: [{ clientY: 10 }] });
    expect(act).toHaveBeenCalledTimes(2);
  });
  it('accepts scrollbar movement both ways, ignoring content clicks and programmatic scrolling', () => {
    const { el, act, send } = log();
    send('scroll');
    send('click');
    send('mouseover');
    send('pointerdown', { offsetX: 10 });
    el.scrollTop += 10;
    send('scroll');
    expect(act).not.toHaveBeenCalled();
    send('pointerdown', { offsetX: el.clientWidth });
    el.scrollTop += 10;
    send('scroll');
    el.scrollTop -= 10;
    send('scroll');
    expect(act).toHaveBeenCalledTimes(2);
    send('scrollend');
    el.scrollTop += 10;
    send('scroll');
    expect(act).toHaveBeenCalledTimes(2);
  });
  it('preserves companion newer-only intent', () => {
    const { act, send } = log(true);
    send('wheel', { deltaY: -1 });
    send('keydown', { key: 'ArrowUp' });
    send('keydown', { key: ' ', shiftKey: true });
    send('touchstart', { touches: [{ clientY: 10 }] });
    send('touchmove', { touches: [{ clientY: 20 }] });
    expect(act).not.toHaveBeenCalled();
    send('wheel', { deltaY: 1 });
    expect(act).toHaveBeenCalledOnce();
  });
});
