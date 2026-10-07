// A window's first paint waits for its stored settings and plugin list, so it never opens on fallbacks (the default layout).
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so signals update as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

// Renderer modules (DOM types): imported by path so the node type-check doesn't follow them.
const FIRST_PAINT = '../src/plugin-sdk/renderer/firstPaint';
const SETTINGS = '../src/plugin-sdk/renderer/settings';
const PLUGIN_LIST = '../src/plugin-sdk/renderer/pluginList';

type FirstPaint = { firstPaintReady(): Promise<void> };
type Settings = { createSetting<T>(key: string, fallback: T, normalize: (v: unknown) => T): [() => T, unknown, { loaded: Promise<void> }] };

/** A preload API whose core calls answer only when the test says. */
function deferredCore() {
  const answers = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  const answer = (name: string) => new Promise((resolve, reject) => answers.set(name, { resolve, reject }));
  return {
    answers,
    api: { core: { getSetting: (key: string) => answer(`getSetting ${key}`), plugins: () => answer('plugins') }, onEvent: () => () => undefined },
  };
}

/** Whether `p` has settled once pending callbacks run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r));
  return done;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : 'fallback');

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('the first paint', () => {
  it('waits for every setting and the plugin list, then sees stored values', async () => {
    const core = deferredCore();
    vi.stubGlobal('window', { chattypop: core.api });
    const { createSetting } = (await import(SETTINGS)) as Settings;
    await import(PLUGIN_LIST);
    const [layout] = createSetting('layout', 'fallback', asString);
    const ready = ((await import(FIRST_PAINT)) as FirstPaint).firstPaintReady();
    core.answers.get('getSetting layout')!.resolve('custom-1');
    expect(await settled(ready)).toBe(false);
    core.answers.get('plugins')!.resolve([]);
    expect(await settled(ready)).toBe(true);
    expect(layout()).toBe('custom-1');
  });

  it('opens on fallbacks when a read fails', async () => {
    const core = deferredCore();
    vi.stubGlobal('window', { chattypop: core.api });
    const { createSetting } = (await import(SETTINGS)) as Settings;
    const [layout, , { loaded }] = createSetting('layout', 'fallback', asString);
    const failure = loaded.catch((err: unknown) => err);
    const ready = ((await import(FIRST_PAINT)) as FirstPaint).firstPaintReady();
    core.answers.get('getSetting layout')!.reject(new Error('core exited'));
    expect(await settled(ready)).toBe(true);
    expect(layout()).toBe('fallback');
    expect(await failure).toBeInstanceOf(Error);
  });

  it("doesn't wait for a setting created after it was released", async () => {
    const core = deferredCore();
    vi.stubGlobal('window', { chattypop: core.api });
    const { createSetting } = (await import(SETTINGS)) as Settings;
    const ready = ((await import(FIRST_PAINT)) as FirstPaint).firstPaintReady();
    createSetting('late', 'fallback', asString);
    expect(await settled(ready)).toBe(true);
  });
});
