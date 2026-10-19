import { onCleanup } from '@plugin-sdk/renderer/containment';
import { api } from '@/api';
import { pageShown } from '@plugin-sdk/renderer/panelShown';
import { createResource } from 'solid-js';
import { SETTINGS_KEYS, normalizeCountedBots } from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { onAppEvent, onArchiveChange } from './events';

export const [countedBots, setCountedBots, { loaded: countedBotsLoaded }] = createSetting<string[]>(SETTINGS_KEYS.countedBots, [], normalizeCountedBots);

/** Counts bot `id`'s messages as new, or stops; settles when the write does. */
export function setBotCounted(id: string, on: boolean): Promise<void> {
  const rest = countedBots().filter((x) => x !== id);
  return setCountedBots(on ? [...rest, id] : rest);
}

/** Load only while Settings shows the bot list; archive and privacy changes keep that list current. */
export function createArchivedBots() {
  const [bots, { refetch, mutate }] = createResource(pageShown, () => api.core.archivedBots());
  const refresh = () => { if (pageShown()) return refetch(); };
  const invalidate = (): void => {
    mutate(undefined);
    if (pageShown()) void refetch(false);
  };
  const offs = [
    onArchiveChange({ kinds: ['messages', 'edits', 'deletes', 'names'], shown: pageShown }, refresh),
    onAppEvent('privacy-changed', invalidate),
    onAppEvent('self-changed', () => void refresh()),
  ];
  onCleanup(() => offs.forEach((off) => off()));
  return bots;
}
