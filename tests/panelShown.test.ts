import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = await import('solid-js');
const listeners = new Map<string, () => void>();
const page = { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) };
vi.stubGlobal('document', page);
const path = '../src/plugin-sdk/renderer/panelShown';
const { panelShown, trackPanelShown } = await import(path) as {
  panelShown(id: string): () => boolean;
  trackPanelShown(id: () => string, shown: () => boolean): void;
};

describe('shared desktop and phone panel visibility', () => {
  it('requires a shown placement and page, and removes disposed placements', () => {
    const [shown, setShown] = createSignal(false);
    let dispose!: () => void;
    createRoot((end) => { dispose = end; trackPanelShown(() => 'panel', shown); });
    const visible = panelShown('panel');
    expect(visible()).toBe(false);
    setShown(true); expect(visible()).toBe(true);
    page.visibilityState = 'hidden'; listeners.get('visibilitychange')!(); expect(visible()).toBe(false);
    page.visibilityState = 'visible'; listeners.get('visibilitychange')!(); expect(visible()).toBe(true);
    setShown(false); expect(visible()).toBe(false);
    dispose(); expect(visible()).toBe(false);
  });
});
