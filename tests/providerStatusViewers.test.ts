import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Solid's Node build omits resources' reactive sources; use the browser-like CJS build.
const solid = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
vi.mock('solid-js', () => solid);
const { aiStatus } = vi.hoisted(() => ({ aiStatus: vi.fn(async () => [{ id: 'claude', available: true, models: [] }]) }));
vi.mock('@/api', () => ({ api: { core: { aiStatus, getSetting: async () => undefined, setSetting: async () => undefined }, onEvent: () => () => undefined } }));
vi.mock('@/state/ui', () => {
  const [settingsOpen, setSettingsOpen] = solid.createSignal(false);
  return { settingsOpen, setSettingsOpen };
});
vi.mock('@/theme/customTheme', () => ({ customBackgrounds: () => [], wearCustomTheme: () => undefined }));
vi.mock('@/theme/panelColors', () => ({ wearPanelColors: () => undefined }));

// Renderer module: imported by path so the node type-check doesn't follow it.
const prefsPath = '../src/renderer/src/state/preferences';
const prefs = (await import(prefsPath)) as { providerStatus(): { id: string }[]; keepProviderStatusLoaded(): void };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

describe('provider status outside Settings', () => {
  it('stays unread until a component that shows it mounts, then loads', async () => {
    await settle();
    expect(aiStatus).not.toHaveBeenCalled();
    expect(prefs.providerStatus()).toEqual([]);
    dispose = solid.createRoot((done) => { prefs.keepProviderStatusLoaded(); return done; });
    await settle();
    expect(aiStatus).toHaveBeenCalledTimes(1);
    expect(prefs.providerStatus().map((s) => s.id)).toEqual(['claude']);
  });
});
