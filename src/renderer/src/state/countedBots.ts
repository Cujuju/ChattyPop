import { api } from '@/api';
import { createResource, onCleanup } from 'solid-js';
import { SETTINGS_KEYS, normalizeCountedBots } from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { ARCHIVE_REFRESH_DEBOUNCE_MS, onAppEvent, onAppEventDebounced } from './events';

export const [countedBots, setCountedBots, { loaded: countedBotsLoaded }] = createSetting<string[]>(SETTINGS_KEYS.countedBots, [], normalizeCountedBots);

/** Counts bot `id`'s messages as new, or stops; settles when the write does. */
export function setBotCounted(id: string, on: boolean): Promise<void> {
  const rest = countedBots().filter((x) => x !== id);
  return setCountedBots(on ? [...rest, id] : rest);
}

/** Load only while Settings shows the bot list; archive and privacy changes keep that list current. */
export function createArchivedBots() {
  const [bots, { refetch }] = createResource(() => api.core.archivedBots());
  const offs = [
    onAppEventDebounced('archive-changed', ARCHIVE_REFRESH_DEBOUNCE_MS, () => void refetch()),
    onAppEvent('privacy-changed', () => void refetch()),
    onAppEvent('self-changed', () => void refetch()),
  ];
  onCleanup(() => offs.forEach((off) => off()));
  return bots;
}
