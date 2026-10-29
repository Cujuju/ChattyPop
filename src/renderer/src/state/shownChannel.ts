// The channel the Chat area shows, live client or Archive, and switching between them.
import { containedRoot } from '@plugin-sdk/renderer/containment';
import { api } from '@/api';
import { createEffect, createSignal } from 'solid-js';
import { archiveChannelId, openArchive } from './archive';
import { chatSource, setChatSource } from './chat';
import { inCompanion, inPanelWindow } from './ui';
import { channelById } from './directory';
import { createPushedValue, onAppEvent } from './events';

/** The channel the live Discord client last showed. */
export const [liveChannelId, setLiveChannelId] = createSignal<string | null>(null);
onAppEvent('live-channel', (e) => setLiveChannelId(e.channelId));
// A window opened after the client navigated (a panel window) starts from where it is; a newer event wins.
void api.discord.shownChannel().then((c) => {
  if (c && liveChannelId() === null) setLiveChannelId(c.channelId);
});

const mirroredChannelId = inPanelWindow ? createPushedValue(() => api.getShownChannel(), 'shown-channel', (e) => e.channelId).value : () => null;

/** The main window's shown channel in panel windows; otherwise this window's live or Archive channel. */
export const shownChannelId = (): string | null => inPanelWindow ? mirroredChannelId() : chatSource() === 'live' ? liveChannelId() : archiveChannelId();

if (!inPanelWindow && !inCompanion) containedRoot(() => createEffect(() => api.reportShownChannel(shownChannelId())));

/** Sidebar picks move visible live clients; otherwise open Archive. */
export function openChannel(c: { id: string; guildId: string }): void {
  if (chatSource() === 'live') api.discord.openChannel(c.guildId, c.id);
  else void openArchive(c.id);
}

/** Shows a channel in the live client, from the Archive: a DM it holds no history for is read there. */
export function openLive(c: { id: string; guildId: string }): void {
  api.discord.openChannel(c.guildId, c.id);
  setChatSource('live');
}

/** Switches the Chat area to the live client, following the Archive: the live client opens the Archive's channel when it differs. */
export function showLive(): void {
  const c = channelById(archiveChannelId() ?? '');
  if (c && c.id !== liveChannelId()) openLive(c);
  else setChatSource('live');
}

/** Switches to Archive and follows a different archived live-client channel. Otherwise preserves the Archive channel. */
export function showArchive(): void {
  const live = liveChannelId();
  const archived = live !== null && channelById(live)?.optedIn === true;
  if (archived && live !== archiveChannelId()) void openArchive(live);
  else setChatSource('archive');
}
