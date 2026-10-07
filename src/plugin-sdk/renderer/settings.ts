// Plugin SDK, renderer: settings persisted in the archive's settings table, one factory for plugins and host stores alike.
import { api } from '@/api';
import { createEffect, createSignal, on, type Accessor } from 'solid-js';
import { onAppEvent } from './appEvents';
import { holdFirstPaint } from './firstPaint';

export interface SettingOptions<T> {
  /** Seeds settings when stored values normalize to fallback. Rejected seeds write nothing and retry when seedWhen next becomes true. */
  seed?: () => Promise<T>;
  /** Whether `seed` can read now (e.g. its plugin is on and callable here). Reactive; seeding waits for it. Default: always. */
  seedWhen?: () => boolean;
}

export interface SettingExtras<T> {
  /** Merges fields into the current value (read at call time) and writes it back; settles when the write does. */
  patch: (p: Partial<T>) => Promise<void>;
  /** Settles once the stored value is adopted (and seeded). */
  loaded: Promise<void>;
}

/** Archive-persisted signal starts with fallback, adopts normalized stored values, then writes changes. normalize must accept any input and return a valid value. */
export function createSetting<T>(
  key: string,
  fallback: T,
  normalize: (v: unknown) => T,
  opts: SettingOptions<T> = {},
): [Accessor<T>, (v: T) => Promise<void>, SettingExtras<T>] {
  const [value, setValue] = createSignal<T>(fallback);
  /** Nothing valid is stored and no write has filled it since load: a seed may fill it. */
  let unseeded = false;
  let seeding = false;
  /** Shows `v` at once; the returned promise settles with the stored write (callers that must know it landed await it). */
  const set = (v: T): Promise<void> => {
    unseeded = false;
    const next = normalize(v);
    setValue(() => next);
    return Promise.resolve(api.core.setSetting(key, next));
  };
  const { seed, seedWhen = () => true } = opts;
  const trySeed = async (): Promise<void> => {
    if (!seed || !unseeded || seeding || !seedWhen()) return;
    seeding = true;
    try {
      const seeded = await seed();
      if (unseeded) await set(seeded);
    } catch {
      // Nothing stored; seedWhen turning true again retries.
    } finally {
      seeding = false;
    }
  };
  const adopted = api.core.getSetting(key).then((stored) => {
    const next = stored === undefined ? fallback : normalize(stored);
    if (stored !== undefined) setValue(() => next);
    unseeded = next === fallback;
  });
  // The window's first paint shows the stored value, not the fallback (the default layout before the saved one).
  holdFirstPaint(adopted);
  const loaded = adopted.then(trySeed);
  if (seed && opts.seedWhen) createEffect(on(opts.seedWhen, (ready) => ready && void trySeed(), { defer: true }));
  // Another window (a panel window, or the main one) changed it.
  onAppEvent('setting-changed', (e) => {
    if (e.key !== key) return;
    const next = normalize(e.value);
    if (next !== fallback) unseeded = false;
    setValue(() => next);
  });
  const patch = (p: Partial<T>): Promise<void> => set({ ...value(), ...p });
  return [value, set, { patch, loaded }];
}

/** Memo equality for id-list settings: same ids in the same order. */
export const sameIds = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
