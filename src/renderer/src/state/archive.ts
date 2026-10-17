// Loaded archive windows and in-place refreshes after content or label changes.
import { containedRoot } from '@plugin-sdk/renderer/containment';
import { api } from '@/api';
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { normalizeArchivePlace, type ArchivePlace } from '@shared/archivePlace';
import type { ArchiveMessage } from '@shared/contract';
import { DEFAULT_ARCHIVE_DENSITY, SETTINGS_KEYS, normalizeArchiveDensity, type ArchiveDensity } from '@shared/settings';
import { chatSource, setChatSource } from './chat';
import { inCompanion, inPanelWindow } from './ui';
import { channelById, refetchDirectory } from './directory';
import { createPushedValue, onAppEvent, onMessagePartsChanged } from './events';
import { createPagedList } from './paged';
import { messageBefore } from '@shared/messageOrder';
import { textOrNull } from '@shared/normalize';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { sentRows } from './outboxSent';

export type { ArchiveDensity };
/** Cozy: avatars and author groups. Compact: F2's one-line log. */
export const [archiveDensity, setArchiveDensity] = createSetting<ArchiveDensity>(SETTINGS_KEYS.archiveDensity, DEFAULT_ARCHIVE_DENSITY, normalizeArchiveDensity);

/** Messages fetched per request when opening or scrolling the Archive view. */
const PAGE_SIZE = 100;
/** Pages a catch-up reads at most in one go (100 pages: 10,000 messages); past it the window detaches and the view pages on. */
const MAX_CATCH_UP_PAGES = 100;

export const [archiveChannelId, setArchiveChannelId] = createSignal<string | null>(null);
/** The channel last opened in the Archive, restored on start. The phone keeps its own, unstored. */
const [lastArchiveChannel, setLastArchiveChannel, { loaded: lastArchiveChannelLoaded }] = createSetting<string | null>(
  SETTINGS_KEYS.archiveChannel,
  null,
  (v) => textOrNull(v),
);
/** Where the owner last looked in it (keepArchivePlace); the phone keeps its own, in its storage. */
const [lastArchivePlace, setLastArchivePlace, { loaded: lastArchivePlaceLoaded }] = createSetting<ArchivePlace | null>(
  SETTINGS_KEYS.archivePlace,
  null,
  normalizeArchivePlace,
);
const [lastArchiveChannelReady, setLastArchiveChannelReady] = createSignal(false);
void Promise.all([lastArchiveChannelLoaded, lastArchivePlaceLoaded]).then(() => setLastArchiveChannelReady(true));

/** Nothing open yet: opens the last channel the Archive showed if `listed` holds it (where the owner last looked), else the first listed. Waits for the stored ones to load. */
export function openRestoredArchive(listed: readonly { id: string }[]): void {
  if (archiveChannelId() || !lastArchiveChannelReady()) return;
  const last = lastArchiveChannel();
  const pick = listed.find((c) => c.id === last) ?? listed[0];
  const place = lastArchivePlace();
  if (pick) void (place?.channelId === pick.id ? openArchiveAt(place) : openArchive(pick.id));
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
export const archiveState = {
  get items() { return atNewest() ? sentRows.merge(archiveChannelId(), list.state.items) : list.state.items; },
  get loading() { return list.state.loading; },
  get reachedStart() { return list.state.reachedStart; },
};
containedRoot(() => createEffect(() => sentRows.reconcile(list.state.items)));
/** Prepends the previous page; returns how many messages were added (the view keeps its scroll anchor). */
export const loadOlder = list.loadOlder;

/** True when the loaded window reaches newest messages and accepts arrivals. Older jumps remain detached until Jump to newest. */
export const [atNewest, setAtNewest] = createSignal(true);

const windowReads = new Map<string, Promise<boolean>>();

/** Loads `channelId`'s newest page, or the page around `around`; resolves false when a later load superseded it. */
async function loadWindow(channelId: string, around: string | null): Promise<boolean> {
  let reachesNewest = true;
  const read = list.reload(async () => {
    const page = await api.core.messageWindow({ channelId, limit: PAGE_SIZE, ...(around ? { around } : {}) });
    reachesNewest = page.reachesNewest;
    return { items: page.items, reachedStart: !around && page.items.length < PAGE_SIZE };
  });
  windowReads.set(channelId, read);
  try {
    const loaded = await read;
    if (loaded) setAtNewest(reachesNewest);
    return loaded;
  } finally {
    if (windowReads.get(channelId) === read) windowReads.delete(channelId);
  }
}

export type { ArchivePlace };

/** The place the last open asked for (openArchiveAt): the view puts its message back there, unhighlighted, as it lands. */
export const [openingPlace, setOpeningPlace] = createSignal<ArchivePlace | null>(null);

/** Opens a channel in the Archive view at its newest messages, or around `messageId`. A panel window has no Archive: the main window opens it. */
export async function openArchive(channelId: string, messageId?: string): Promise<void> {
  if (inPanelWindow) return api.showInMainWindow(channelId, messageId);
  setFocusMessageId(messageId ?? null);
  setOpeningPlace(null);
  await open(channelId, messageId ?? null);
}

/** Opens `place`'s channel around its message, the view putting it back where it was; at the newest when it is gone. */
export async function openArchiveAt(place: ArchivePlace): Promise<void> {
  setFocusMessageId(null);
  setOpeningPlace(place);
  await open(place.channelId, place.messageId);
}

async function open(channelId: string, around: string | null): Promise<void> {
  setArchiveChannelId(channelId);
  if (!inCompanion && channelId !== lastArchiveChannel()) void setLastArchiveChannel(channelId);
  // Its last-read mark moves once the Archive shows it on screen (lastRead.ts).
  setChatSource('archive');
  const ticket = ++opens;
  const detail = { channelId, around, ticket };
  performance.mark('cp:restore:start', { detail });
  setArchiveOpening(true);
  try {
    if (await loadWindow(channelId, around)) setArchiveLoads((n) => n + 1);
  } finally {
    // A superseded open leaves the flag to the open that superseded it.
    if (ticket === opens) setArchiveOpening(false);
    performance.mark('cp:restore:end', { detail });
  }
}

/** The view's reader of where the owner is (ArchiveView): undefined while unknown (no view, an open landing). */
let placeReader: () => ArchivePlace | undefined = () => undefined;
export const archivePlace = (): ArchivePlace | undefined => placeReader();
/** Sets the view's place reader; returns its removal. */
export function readArchivePlaceWith(read: () => ArchivePlace | undefined): () => void {
  placeReader = read;
  return () => {
    if (placeReader === read) placeReader = () => undefined;
  };
}

/** A place is stored once the view rests there this long: one settings write per stop, not one per scrolled frame. */
const PLACE_REST_MS = 500;
const samePlace = (a: ArchivePlace | null, b: ArchivePlace): boolean =>
  a !== null && a.channelId === b.channelId && a.messageId === b.messageId && a.bottom === b.bottom;

/** Desktop: stores where the owner is while they can look (`lookable`), so a restart reopens where they last looked. Owner-scoped. */
export function keepArchivePlace(lookable: Accessor<boolean>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  createEffect(() => {
    const place = lookable() ? archivePlace() : undefined;
    clearTimeout(timer);
    if (place && !samePlace(lastArchivePlace(), place)) timer = setTimeout(() => void setLastArchivePlace(place), PLACE_REST_MS);
  });
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

/** Each channel's row reads (catch-up, refreshes), queued so each applies after those begun before it: none restores an older snapshot. */
const rowReads = new Map<string, Promise<void>>();

/** Runs `read` after the channel's earlier row reads and any window load, if the channel is still open. */
async function inTurn(channelId: string, read: () => Promise<void>): Promise<void> {
  const work = (rowReads.get(channelId) ?? Promise.resolve())
    .catch(() => undefined) // A failed read doesn't hold back later ones.
    .then(async () => {
      await windowReads.get(channelId);
      if (archiveChannelId() === channelId) await read();
    });
  rowReads.set(channelId, work);
  try {
    await work;
  } finally {
    if (rowReads.get(channelId) === work) rowReads.delete(channelId);
  }
}

/** Open-channel changes: a window at the newest catches up on arrivals; other changes (and name/role changes) re-read loaded rows in place. */
onAppEvent('archive-changed', async (e) => {
  const channelId = archiveChannelId();
  const changed = channelId !== null && e.channelIds.includes(channelId);
  if (!channelId || (!changed && !e.namesChanged)) return;
  const insertOnly = e.insertOnlyChannelIds?.includes(channelId) === true;
  await inTurn(channelId, async () => {
    // Rows appended after this one, and the newest page, are read after the change: already current.
    const last = list.state.items.at(-1);
    let fresh: ArchiveMessage | null = null;
    if (changed && atNewest()) {
      const reached = await catchUp(channelId);
      if (!reached || !insertOnly) fresh = await refreshNewest(channelId);
    }
    if (e.namesChanged || (changed && !insertOnly)) {
      await rereadRows(channelId, (m) => (!last || !messageBefore(last, m)) && (!fresh || messageBefore(m, fresh)));
    }
  });
});

/** Appends newer pages without gaps; true once it read the newest. Past its budget the window detaches, and the view pages on from there. */
async function catchUp(channelId: string): Promise<boolean> {
  if (!list.state.items.length) return false;
  for (let pages = 0; pages < MAX_CATCH_UP_PAGES; pages++) {
    if (archiveChannelId() !== channelId) return false;
    const added = await list.loadNewer();
    // Null: another read is appending already (it carries on), or a reload superseded this one.
    if (added === null) return false;
    if (added < PAGE_SIZE) return true;
  }
  setAtNewest(false);
  return false;
}

/** Re-reads the newest page in place (edits, deletions, rows inserted among them); resolves with its oldest row once applied, else null. */
async function refreshNewest(channelId: string): Promise<ArchiveMessage | null> {
  let oldest: ArchiveMessage | null = null;
  await list.update(() => query({ channelId, limit: PAGE_SIZE }), (latest, loaded) => {
    const first = latest[0];
    const last = loaded.at(-1);
    // A page starting past the last loaded row would leave out the rows between them.
    if (archiveChannelId() !== channelId || !atNewest() || !first || (last && messageBefore(last, first))) return [...loaded];
    oldest = first;
    return [...loaded.filter((m) => messageBefore(m, first)), ...latest];
  });
  return oldest;
}

/** Re-reads the loaded rows `pick` takes, by id and in place, PAGE_SIZE ids per read; a row the archive no longer shows stays as it was. */
async function rereadRows(channelId: string, pick: (m: ArchiveMessage) => boolean): Promise<void> {
  const ids = list.state.items.filter(pick).map((m) => m.id);
  if (!ids.length) return;
  const chunks = Array.from({ length: Math.ceil(ids.length / PAGE_SIZE) }, (_, i) => ids.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
  await list.update(async () => (await Promise.all(chunks.map((c) => api.core.messagesByIds(c)))).flat(), (rows, items) => {
    if (archiveChannelId() !== channelId) return [...items];
    const byId = new Map(rows.map((m) => [m.id, m]));
    return items.map((m) => byId.get(m.id) ?? m);
  });
}

/** Loads newer pages near jumped-window ends. Reaching newest resumes live arrivals and refreshes messages arriving during catch-up. */
export async function loadNewer(): Promise<void> {
  const channelId = archiveChannelId();
  if (!channelId || atNewest()) return;
  const added = await list.loadNewer();
  if (added === null || added >= PAGE_SIZE || archiveChannelId() !== channelId) return;
  // New posts are now this window's to show; any that arrived since that read are appended next.
  setAtNewest(true);
  await inTurn(channelId, async () => {
    if (!atNewest()) return;
    await catchUp(channelId);
    await refreshNewest(channelId);
  });
}

/** Re-reads loaded messages in place (chips, reactions, polls), wherever they are in the window; null re-reads them all. */
export async function refreshLoaded(ids: string[] | null): Promise<void> {
  const channelId = archiveChannelId();
  if (!channelId) return;
  const wanted = ids && new Set(ids);
  await inTurn(channelId, () => rereadRows(channelId, (m) => !wanted || wanted.has(m.id)));
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

/** A clicked notification: show that message in the Archive. */
onAppEvent('open-message', (e) => void openArchive(e.channelId, e.messageId));
