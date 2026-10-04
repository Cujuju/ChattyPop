// Loaded archive windows and in-place refreshes after content or label changes.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { DEFAULT_ARCHIVE_DENSITY, SETTINGS_KEYS, normalizeArchiveDensity, type ArchiveDensity } from '@shared/settings';
import { chatSource, setChatSource } from './chat';
import { inCompanion, inPanelWindow } from './ui';
import { channelById, refetchDirectory } from './directory';
import { onAppEvent, onMessagePartsChanged } from './events';
import { createPagedList } from './paged';
import { messageBefore } from '@shared/messageOrder';
import { textOrNull } from '@shared/normalize';
import { createSetting } from '@plugin-sdk/renderer/settings';

export type { ArchiveDensity };
/** Cozy: avatars and author groups. Compact: F2's one-line log. */
export const [archiveDensity, setArchiveDensity] = createSetting<ArchiveDensity>(SETTINGS_KEYS.archiveDensity, DEFAULT_ARCHIVE_DENSITY, normalizeArchiveDensity);

/** Messages fetched per request when opening or scrolling the Archive view. */
const PAGE_SIZE = 100;
/** Pages a catch-up reads at most in one go (100 pages: 10,000 messages); the next change picks up the rest. */
const MAX_CATCH_UP_PAGES = 100;

export const [archiveChannelId, setArchiveChannelId] = createSignal<string | null>(null);
/** The channel last opened in the Archive, restored on start. The phone keeps its own, unstored. */
const [lastArchiveChannel, setLastArchiveChannel, { loaded: lastArchiveChannelLoaded }] = createSetting<string | null>(
  SETTINGS_KEYS.archiveChannel,
  null,
  (v) => textOrNull(v),
);
const [lastArchiveChannelReady, setLastArchiveChannelReady] = createSignal(false);
void lastArchiveChannelLoaded.then(() => setLastArchiveChannelReady(true));

/** Nothing open yet: opens the last channel the Archive showed if `listed` holds it, else the first listed. Waits for the stored one to load. */
export function openRestoredArchive(listed: readonly { id: string }[]): void {
  if (archiveChannelId() || !lastArchiveChannelReady()) return;
  const last = lastArchiveChannel();
  const pick = listed.find((c) => c.id === last) ?? listed[0];
  if (pick) void openArchive(pick.id);
}
/** Bumped when an open completes, so the view re-scrolls even when the channel is unchanged. */
export const [archiveLoads, setArchiveLoads] = createSignal(0);
/** An open (channel switch or jump) is loading: the rows shown may be the last channel's or a stretch it replaces. */
export const [archiveOpening, setArchiveOpening] = createSignal(false);
let opens = 0;
/** Message to scroll to and highlight (citation jumps). */
export const [focusMessageId, setFocusMessageId] = createSignal<string | null>(null);

const query = api.core.messagePage;

const list = createPagedList<ArchiveMessage>(
  PAGE_SIZE,
  (oldest) => query({ channelId: oldest.channelId, limit: PAGE_SIZE, before: oldest.id }),
  (newest) => query({ channelId: newest.channelId, limit: PAGE_SIZE, after: newest.id }),
);
export const archiveState = list.state;
/** Prepends the previous page; returns how many messages were added (the view keeps its scroll anchor). */
export const loadOlder = list.loadOlder;

/**
 * The loaded window reaches the channel's newest message, so new ones join it and the view may follow them. False after
 * a jump to an older stretch, until the channel is opened at its newest again (Jump to newest).
 */
export const [atNewest, setAtNewest] = createSignal(true);

/** Loads `channelId`'s newest page, or the page around `around`; resolves false when a later load superseded it. */
async function loadWindow(channelId: string, around: string | null): Promise<boolean> {
  let reachesNewest = true;
  const loaded = await list.reload(async () => {
    const page = await query({ channelId, limit: PAGE_SIZE, ...(around ? { around } : {}) });
    if (around) {
      const [newest] = await query({ channelId, limit: 1 });
      reachesNewest = !newest || page.some((m) => m.id === newest.id);
    }
    return { items: page, reachedStart: !around && page.length < PAGE_SIZE };
  });
  if (loaded) setAtNewest(reachesNewest);
  return loaded;
}

/** Opens a channel in the Archive view at its newest messages, or around `messageId`. A panel window has no Archive: the main window opens it. */
export async function openArchive(channelId: string, messageId?: string): Promise<void> {
  if (inPanelWindow) return api.showInMainWindow(channelId, messageId);
  setArchiveChannelId(channelId);
  if (!inCompanion && channelId !== lastArchiveChannel()) void setLastArchiveChannel(channelId);
  setFocusMessageId(messageId ?? null);
  // Its last-read mark moves once the Archive shows it on screen (lastRead.ts).
  setChatSource('archive');
  const ticket = ++opens;
  setArchiveOpening(true);
  try {
    if (await loadWindow(channelId, messageId ?? null)) setArchiveLoads((n) => n + 1);
  } finally {
    // A superseded open leaves the flag to the open that superseded it.
    if (ticket === opens) setArchiveOpening(false);
  }
}

/** Privacy mode changed: close the open channel if it is now hidden, else reload what is loaded (messages may be hidden or back). */
onAppEvent('privacy-changed', async () => {
  const channelId = archiveChannelId();
  if (!channelId) return;
  await refetchDirectory();
  if (archiveChannelId() !== channelId) return;
  if (!channelById(channelId)) {
    setArchiveChannelId(null); // the Archive view opens the first visible channel
    // A reload, so reads begun before privacy changed can't restore the hidden channel's messages.
    await list.reload(async () => ({ items: [], reachedStart: true }));
    return;
  }
  await loadWindow(channelId, focusMessageId());
});

/**
 * New or changed messages in the open channel: refresh the newest page in place, while the window reaches it. Members
 * or roles changed: re-read the loaded rows, whose names, colours and marks may differ.
 */
onAppEvent('archive-changed', async (e) => {
  const channelId = archiveChannelId();
  if (channelId && e.channelIds.includes(channelId) && atNewest()) {
    await catchUp(channelId);
    await refreshNewest(channelId);
  }
  if (e.namesChanged) await refreshLoaded(null);
});

/**
 * Appends every message newer than the newest loaded, a page at a time: new posts join the window with no gap, however
 * many arrived. Paged, so a refresh of loaded rows (tags, names) can't supersede it.
 */
async function catchUp(channelId: string): Promise<void> {
  for (let pages = 0; pages < MAX_CATCH_UP_PAGES && archiveChannelId() === channelId; pages++) {
    const added = await list.loadNewer();
    // Null: another read is appending already (it carries on), or a reload superseded this one.
    if (added === null || added < PAGE_SIZE) return;
  }
}

/** Re-reads the newest page in place (edits, deletions), keeping every older loaded message. */
async function refreshNewest(channelId: string): Promise<void> {
  await list.update(() => query({ channelId, limit: PAGE_SIZE }), (latest, loaded) => {
    if (archiveChannelId() !== channelId || !atNewest()) return [...loaded];
    const firstLatest = latest[0];
    return [...(firstLatest ? loaded.filter((m) => messageBefore(m, firstLatest)) : loaded), ...latest];
  });
}

/**
 * After a jump, the window may stop short of the newest message: appends the next newer page as the view nears its end.
 * Once the newest is loaded, new messages join the window again (and one re-read catches any that came meanwhile).
 */
export async function loadNewer(): Promise<void> {
  const channelId = archiveChannelId();
  if (!channelId || atNewest()) return;
  const added = await list.loadNewer();
  if (added === null || added >= PAGE_SIZE || archiveChannelId() !== channelId) return;
  // New posts are now this window's to show; any that arrived since that read are appended next.
  setAtNewest(true);
  await catchUp(channelId);
  await refreshNewest(channelId);
}

/**
 * Tags changed on some messages (null = any): reload the loaded window in place so their chips update. Messages
 * beyond one window's length from the newest (or the focused) message keep their chips until the channel reopens.
 */
export async function refreshLoaded(ids: string[] | null): Promise<void> {
  const channelId = archiveChannelId();
  const loaded = list.state.items;
  if (!channelId || !loaded.length || (ids && !loaded.some((m) => ids.includes(m.id)))) return;
  const focus = focusMessageId();
  await list.update(() => query({ channelId, limit: loaded.length, ...(focus ? { around: focus } : {}) }), (page, items) => {
    if (archiveChannelId() !== channelId) return [...items];
    const byId = new Map(page.map((m) => [m.id, m]));
    return items.map((m) => byId.get(m.id) ?? m);
  });
}

/** The channel the live Discord client last showed. */
export const [liveChannelId, setLiveChannelId] = createSignal<string | null>(null);
onAppEvent('live-channel', (e) => setLiveChannelId(e.channelId));
// Plugins' chips or attachment notes changed (a tag, a transcript's progress): re-read those messages if shown.
onMessagePartsChanged((ids) => void refreshLoaded(ids));
// A window opened after the client navigated (a panel window) starts from where it is; a newer event wins.
void api.discord.shownChannel().then((c) => {
  if (c && liveChannelId() === null) setLiveChannelId(c.channelId);
});

/** The channel the Chat area is showing: the live client's while it is shown, else the Archive's. */
export const shownChannelId = (): string | null => (chatSource() === 'live' ? liveChannelId() : archiveChannelId());

/** A sidebar pick: moves the live client while it is shown (the Archive follows it later), else opens the Archive. */
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

/**
 * Switches the Chat area to the Archive, following the live client: if the channel open there is archived and
 * differs from the Archive's, the Archive opens it. Otherwise the Archive stays where it was.
 */
export function showArchive(): void {
  const live = liveChannelId();
  const archived = live !== null && channelById(live)?.optedIn === true;
  if (archived && live !== archiveChannelId()) void openArchive(live);
  else setChatSource('archive');
}

/** A clicked notification: show that message in the Archive. */
onAppEvent('open-message', (e) => void openArchive(e.channelId, e.messageId));
