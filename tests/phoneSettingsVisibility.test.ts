import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Run the same reactive effects as the phone; Solid's Node build omits effects.
const solid = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
vi.mock('solid-js', () => solid);
vi.mock('@/state/ui', () => {
  const [settingsOpen, setSettingsOpen] = solid.createSignal(false);
  return { settingsOpen, setSettingsOpen };
});

const visibilityPath = '../src/renderer/src/phone/settingsVisibility';
const uiPath = '../src/renderer/src/state/ui';
const { trackPhoneSettingsVisibility } = await import(visibilityPath) as {
  trackPhoneSettingsVisibility(shown: () => boolean, onShow: () => void): void;
};
const { settingsOpen, setSettingsOpen } = await import(uiPath) as {
  settingsOpen(): boolean;
  setSettingsOpen(open: boolean): void;
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  setSettingsOpen(false);
});

/** The companion keeps visited panes mounted and computes visibility from its active tab. */
function phone(initial = 'archive') {
  const [tab, setTab] = solid.createSignal(initial);
  const [refresh, setRefresh] = solid.createSignal(0);
  const showSettings = vi.fn(() => {
    if (tab() !== 'settings') setTab('settings');
  });
  dispose = solid.createRoot((done) => {
    // Models other mounted UI reading the current tab and independently changing data.
    // Refreshing it exercises both possible orders of the Settings listeners.
    solid.createEffect(() => { tab(); refresh(); });
    trackPhoneSettingsVisibility(() => tab() === 'settings', showSettings);
    return done;
  });
  return { tab, setTab, showSettings, refresh: () => setRefresh((value) => value + 1) };
}

describe('phone Settings navigation', () => {
  it.each([false, true])('leaves Settings on the first channel selection after repeated visits (refresh: %s)', (refreshBeforePick) => {
    const { tab, setTab, showSettings, refresh } = phone('settings');
    for (let visit = 0; visit < 5; visit++) {
      if (refreshBeforePick) refresh();
      setTab('archive');
      expect(tab()).toBe('archive');
      expect(settingsOpen()).toBe(false);
      setTab('settings');
      expect(settingsOpen()).toBe(true);
    }
    expect(showSettings).not.toHaveBeenCalled();
  });

  it.each([false, true])('still opens for an external request and lets the next channel selection leave (refresh: %s)', (refreshBeforePick) => {
    const { tab, setTab, showSettings, refresh } = phone();
    for (let visit = 0; visit < 5; visit++) {
      setSettingsOpen(true);
      expect(tab()).toBe('settings');
      expect(settingsOpen()).toBe(true);
      expect(showSettings).toHaveBeenCalledTimes(visit + 1);
      if (refreshBeforePick) refresh();
      setTab('archive');
      expect(tab()).toBe('archive');
      expect(settingsOpen()).toBe(false);
    }
  });

  it.each([false, true])('allows navigation to another section while Settings stays mounted (refresh: %s)', (refreshBeforePick) => {
    const { tab, setTab, refresh } = phone('settings');
    if (refreshBeforePick) refresh();
    setTab('links');
    expect(tab()).toBe('links');
    expect(settingsOpen()).toBe(false);
  });
});
