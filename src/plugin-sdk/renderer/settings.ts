// Plugin SDK, renderer: settings persisted in the archive's settings table, one factory for plugins and host stores alike.
import { api } from '@/api';
import { createEffect, createSignal, on, type Accessor } from 'solid-js';
import { onAppEvent } from './appEvents';

export interface SettingOptions<T> {
  /**
   * Fills the setting when nothing valid is stored (the stored value normalizes to `fallback`), e.g. on first run. A
   * rejected seed stores nothing: seeding is tried again when `seedWhen` next turns true.
   */
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

/**
 * A signal persisted in the archive's settings table. Starts at `fallback`, adopts the stored value
 * once loaded (passed through `normalize`, which must return a valid value for any input), and
 * writes every change back.
 */
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
  const loaded = api.core.getSetting(key).then(async (stored) => {
    const adopted = stored === undefined ? fallback : normalize(stored);
    if (stored !== undefined) setValue(() => adopted);
    unseeded = adopted === fallback;
    await trySeed();
  });
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
