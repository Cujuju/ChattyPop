// Channels the Chat area showed, most recent first: the channel switcher's order and the back shortcut's target.
import { createEffect, createRoot, on } from 'solid-js';
import { SETTINGS_KEYS } from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { openArchive, openChannel, shownChannelId } from './archive';
import { chatSource } from './chat';
import { archivedChannels, channelById, type ArchivedChannel } from './directory';
import { normalizeRecentChannels, previousChannel, switcherOrder, withRecent } from './channelRecentsRules';
import { outsideLayout } from './ui';

export const [recentChannels, setRecentChannels, { loaded }] = createSetting<string[]>(SETTINGS_KEYS.recentChannels, [], normalizeRecentChannels);

// The main window records, once the stored list is in (an earlier write would replace it); others show no Chat area.
if (!outsideLayout) {
  void loaded.then(() =>
    createRoot(() =>
      createEffect(
        on(shownChannelId, (id) => {
          if (id && recentChannels()[0] !== id) void setRecentChannels(withRecent(recentChannels(), id));
        }),
      ),
    ),
  );
}

/** Archived channels and DMs matching `query`, for the switcher: recent ones first (see switcherOrder). Reactive. */
export const switcherChannels = (query: string): ArchivedChannel[] => switcherOrder(archivedChannels(), recentChannels(), shownChannelId(), query);

/** A switcher pick: opens it in the Archive. */
export const openSwitched = (c: ArchivedChannel): void => void openArchive(c.id);

/** The live client shows any known channel; the Archive only an archived one. */
const showable = (id: string): boolean => {
  const c = channelById(id);
  return c !== undefined && (chatSource() === 'live' || c.optedIn);
};

/** Shows the channel shown before this one, where the Chat area is (live client or Archive): flips between two. */
export function showPreviousChannel(): void {
  const id = previousChannel(recentChannels(), shownChannelId(), showable);
  const c = id === null ? undefined : channelById(id);
  if (c) openChannel(c);
}
