// A value's load-time read answers after a newer pushed or locally written value: the newer one stays (pushed values,
// settings).
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

// Uses Solid's browser runtime so signals update as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

// Renderer modules (DOM types): imported by path so the node type-check doesn't follow them.
const EVENTS = '../src/renderer/src/state/events';
const SETTINGS = '../src/plugin-sdk/renderer/settings';

type Pushed = { createPushedValue<T>(load: () => Promise<T>, type: AppEvent['type'], pick: (e: AppEvent) => T): { value(): T | null } };
type Settings = { createSetting<T>(key: string, fallback: T, normalize: (v: unknown) => T): [() => T, (v: T) => Promise<void>, unknown] };

/** A preload API whose reads answer when the test says, and whose events the test pushes. */
function window_() {
  let listener: (e: AppEvent) => void = () => undefined;
  let answer: (v: unknown) => void = () => undefined;
  const read = (): Promise<unknown> => new Promise((resolve) => (answer = resolve));
  vi.stubGlobal('window', {
    chattypop: {
      core: { getSetting: read, setSetting: () => Promise.resolve() },
      onEvent: (l: (e: AppEvent) => void) => ((listener = l), () => undefined),
    },
  });
  return { read, push: (e: AppEvent) => listener(e), answer: (v: unknown) => answer(v) };
}

const settled = (): Promise<void> => new Promise((done) => setImmediate(done));
const asBool = (v: unknown): boolean => v === true;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('a pushed value', () => {
  it('keeps a push over an older answer to its load-time read', async () => {
    const win = window_();
    const { createPushedValue } = (await import(EVENTS)) as Pushed;
    const self = createPushedValue(win.read as () => Promise<string | null>, 'self-changed', (e) => (e as { userId: string }).userId);
    win.push({ type: 'self-changed', userId: 'current-owner' } as AppEvent);
    expect(self.value()).toBe('current-owner');
    win.answer(null);
    await settled();
    expect(self.value()).toBe('current-owner');
  });

  it('adopts its load-time read when nothing was pushed', async () => {
    const win = window_();
    const { createPushedValue } = (await import(EVENTS)) as Pushed;
    const self = createPushedValue(win.read as () => Promise<string | null>, 'self-changed', (e) => (e as { userId: string }).userId);
    expect(self.value()).toBeNull();
    win.answer('owner');
    await settled();
    expect(self.value()).toBe('owner');
  });
});

describe('a setting', () => {
  it("keeps another window's change over an older stored read", async () => {
    const win = window_();
    const { createSetting } = (await import(SETTINGS)) as Settings;
    const [privacy] = createSetting('privacyMode', false, asBool);
    win.push({ type: 'setting-changed', key: 'privacyMode', value: true } as AppEvent);
    win.answer(false);
    await settled();
    expect(privacy()).toBe(true);
  });

  it('keeps a local write over an older stored read', async () => {
    const win = window_();
    const { createSetting } = (await import(SETTINGS)) as Settings;
    const [privacy, setPrivacy] = createSetting('privacyMode', false, asBool);
    void setPrivacy(true);
    win.answer(false);
    await settled();
    expect(privacy()).toBe(true);
  });

  it('adopts the stored value when nothing changed it while loading', async () => {
    const win = window_();
    const { createSetting } = (await import(SETTINGS)) as Settings;
    const [privacy] = createSetting('privacyMode', false, asBool);
    win.answer(true);
    await settled();
    expect(privacy()).toBe(true);
  });
});
