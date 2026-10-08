import { afterEach, describe, expect, it, vi } from 'vitest';
// Dynamic renderer import keeps DOM-only types out of the Node test project; web typecheck covers the renderer.
const panelPath = '../src/renderer/src/ui/keepOnScreen';
const { EDGE_MARGIN_PX, keepOnScreen } = await import(panelPath) as {
  EDGE_MARGIN_PX: number;
  keepOnScreen: (panel: ReturnType<typeof viewport>, x: number, y: number, flip?: { x?: number; y?: number }) => void;
};

afterEach(() => vi.unstubAllGlobals());

/** Simulates a fixed panel whose rect honors the inline height cap, as the browser does. */
function viewport(keyboardInset: string, width = 375, height = 667) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => keyboardInset }));
  const style: Record<string, string> = {};
  const panel = {
    style,
    getBoundingClientRect: () => ({ width: Math.min(320, Number.parseFloat(style.maxWidth!)), height: Math.min(400, Number.parseFloat(style.maxHeight!)) }),
  };
  return panel;
}

describe('fixed panels stay inside the usable viewport', () => {
  it('caps and flips against native keyboard coverage without a window resize', () => {
    const panel = viewport('300px');
    keepOnScreen(panel, 10, 200, { y: 180 });
    const usableHeight = 667 - 300;
    expect(panel.style.maxHeight).toBe(`${usableHeight - 2 * EDGE_MARGIN_PX}px`);
    expect(Number.parseFloat(panel.style.top!) + panel.getBoundingClientRect().height).toBeLessThanOrEqual(usableHeight - EDGE_MARGIN_PX);
  });

  it('uses keyboard-aware bounds for the flip decision even when the panel is short', () => {
    const panel = viewport('300px');
    panel.getBoundingClientRect = () => ({ width: 100, height: 100 });
    keepOnScreen(panel, 10, 300, { y: 280 });
    expect(panel.style.top).toBe('180px');
  });

  it.each(['0px', ''])('preserves desktop bounds with inset %j', (inset) => {
    const panel = viewport(inset, 1280, 800);
    keepOnScreen(panel, 100, 100);
    expect(panel.style.maxHeight).toBe(`${800 - 2 * EDGE_MARGIN_PX}px`);
    expect(panel.style.left).toBe('100px');
    expect(panel.style.top).toBe('100px');
  });

  it('never writes negative caps when keyboard coverage reaches the window height', () => {
    const panel = viewport('667px');
    keepOnScreen(panel, 10, 200);
    expect(panel.style.maxHeight).toBe('0px');
  });
});
