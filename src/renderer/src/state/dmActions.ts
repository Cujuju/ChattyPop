// Managing a DM (docs/dms.md §4.2, §4.4): the row menu, the mute and members flyouts, and the rename and leave dialogs.
// Each write goes through main's DM service; a failure shows inline where it was asked for.
import { api } from '@/api';
import { createEffect, createRoot, createSignal } from 'solid-js';
import { DM_GUILD_ID } from '@shared/discord';
import {
  GROUP_DM_MAX_MEMBERS,
  MUTE_15_MIN_S,
  MUTE_1_HOUR_S,
  MUTE_24_HOURS_S,
  MUTE_3_HOURS_S,
  MUTE_8_HOURS_S,
  MUTE_UNTIL_UNMUTED,
  type MuteWindow,
} from '@shared/dms';
import { errorText } from '@/ui/format';
import { openLive } from './archive';
import { channelJevItems, localAiItem } from './channelPolicy';
import { channelById, refetchDirectory, setChannelOptIn } from './directory';
import { dmMuted } from './dms';
import { isClosedGroup, isDmChannel, isGroup, isReadOnlyDm, isUnread, type DmChannel } from './dmRules';
import { openAddFriends } from './newMessage';
import { openPerson } from './person';
import { closeWhenLocked, postingUnlocked } from './posting';
import { channelPrivacyItem } from './privacy';
import { openMenuAt, type MenuGroup, type MenuItem, type MenuRun } from './ui';

/** The client's mute lengths (shorter first), then the open-ended one, which sits apart. */
const MUTE_LENGTHS: readonly { window: MuteWindow; label: string }[] = [
  { window: MUTE_15_MIN_S, label: '15 minutes' },
  { window: MUTE_1_HOUR_S, label: '1 hour' },
  { window: MUTE_3_HOURS_S, label: '3 hours' },
  { window: MUTE_8_HOURS_S, label: '8 hours' },
  { window: MUTE_24_HOURS_S, label: '24 hours' },
];
/** The owner counts toward a group's size. */
const OWNER = 1;
/** A one-to-one DM's other person, counted while its roster is unknown. */
const ONE_OTHER = 1;

/** Where a DM action was asked for, so its failure shows there: the sidebar's list or the chat bar. */
export type DmSurface = 'list' | 'bar';
interface DmFailure {
  surface: DmSurface;
  channelId: string;
  text: string;
}
const [failure, setFailure] = createSignal<DmFailure | null>(null);
/** The last DM action that failed on `surface`; null when none has. */
export const dmFailure = (surface: DmSurface): DmFailure | null => (failure()?.surface === surface ? failure() : null);
export const dismissDmFailure = (): void => void setFailure(null);

/** Runs a DM write asked for on `surface`; its failure (Discord's reason) shows there until dismissed or the next run. */
async function act(surface: DmSurface, channelId: string, job: () => Promise<unknown>): Promise<void> {
  setFailure(null);
  try {
    await job();
    await refetchDirectory();
  } catch (err) {
    setFailure({ surface, channelId, text: errorText(err) });
  }
}

/** The rename or leave dialog's conversation; null when neither is open. */
export interface DmDialogState {
  kind: 'rename' | 'leave';
  channelId: string;
}
const [dialog, setDialog] = createSignal<DmDialogState | null>(null);
export const dmDialog = dialog;
export const closeDmDialog = (): void => void setDialog(null);
closeWhenLocked(() => dialog() !== null, closeDmDialog);
/** The dialog's conversation from the directory while the owner can manage it; undefined once not. */
export const dmDialogChannel = (): DmChannel | undefined => {
  const d = dialog();
  const c = d ? channelById(d.channelId) : undefined;
  return c && isDmChannel(c) && manageable(c) ? c : undefined;
};
// Its conversation gone from the list (privacy mode, closed, another account) closes the dialog, so no name of it stays.
createRoot(() =>
  createEffect(() => {
    if (dialog() && !dmDialogChannel()) setDialog(null);
  }),
);

export async function renameDm(c: DmChannel, name: string): Promise<void> {
  await api.discord.renameDm(c.id, name);
  await refetchDirectory();
}
export async function leaveDm(c: DmChannel, quietly: boolean): Promise<void> {
  await api.discord.closeDm(c.id, quietly);
  await refetchDirectory();
}

/** Open, and neither a request nor closed: the conversations the owner can manage. */
export const manageable = (c: DmChannel): boolean => !c.dm.closed && !c.dm.request;

/** The group's size: the owner and every other member; a one-to-one DM is two. Null while a group's roster is unknown. */
export const memberCount = (c: DmChannel): number | null =>
  isGroup(c) && !c.dm.rosterKnown ? null : OWNER + Math.max(c.dm.recipients.length, ONE_OTHER);

export const openInDiscord = (c: DmChannel): void => openLive({ id: c.id, guildId: DM_GUILD_ID });

/** Mute on Discord: the client's lengths, then until turned back on. */
export function muteMenu(c: DmChannel, surface: DmSurface): MenuGroup[] {
  const mute = (window: MuteWindow): MenuRun => () => act(surface, c.id, () => api.discord.muteDm(c.id, window));
  return [
    { heading: 'Mute on Discord', items: MUTE_LENGTHS.map((m) => ({ label: m.label, icon: 'clock', run: mute(m.window) })) },
    { items: [{ label: 'Until I turn it back on', icon: 'bellOff', run: mute(MUTE_UNTIL_UNMUTED) }] },
  ];
}

/**
 * Mute… opens the lengths at `anchor`, looked up as it opens: a row may be drawn anew since its menu opened. Gone (the
 * row left the list), nothing opens. A muted DM unmutes at once.
 */
export function muteItem(c: DmChannel, anchor: () => Element | null | undefined, surface: DmSurface, side: 'below' | 'beside'): MenuItem {
  const open = (): void => {
    const at = anchor();
    if (at?.isConnected) openMenuAt(at, muteMenu(c, surface), side);
  };
  return dmMuted(c)
    ? { label: 'Unmute', icon: 'bell', run: () => act(surface, c.id, () => api.discord.muteDm(c.id, null)) }
    : { label: 'Mute…', icon: 'bellOff', run: open };
}

/** The sidebar's row for `channelId` (Dms.tsx marks each with data-dm-row), as drawn now. */
const dmRow = (channelId: string): Element | null => document.querySelector(`[data-dm-row="${channelId}"]`);

/** The DM row's right-click menu (§4.4), in flat groups; a request or a closed DM offers no management. */
export function dmMenu(c: DmChannel): MenuGroup[] {
  const manage = manageable(c);
  // A request or a group left can't be archived; an archived request can still stop.
  const archiving: MenuItem[] =
    c.optedIn && !isClosedGroup(c)
      ? [{ label: 'Stop archiving', icon: 'archive', detail: 'Keeps its history', run: () => act('list', c.id, () => setChannelOptIn(c.id, false)) }]
      : !c.optedIn && !isReadOnlyDm(c)
        ? [{ label: 'Archive this conversation', icon: 'archive', run: () => act('list', c.id, () => setChannelOptIn(c.id, true)) }]
        : [];
  // Offered only while unread (the row's bold), as in Discord's client: each one sends Discord an ack.
  const markRead: MenuItem[] = isUnread(c) ? [{ label: 'Mark as read', icon: 'check', run: () => act('list', c.id, () => api.core.markDmRead(c.id)) }] : [];
  // Discord writes (mute, rename, add, leave, close) need posting unlocked; Mark as read is an ack, offered while locked.
  const write = manage && postingUnlocked();
  return [
    { items: manage ? [...markRead, ...(write ? [muteItem(c, () => dmRow(c.id), 'list', 'beside')] : [])] : [] },
    { items: [...archiving, channelPrivacyItem(c), localAiItem(c), ...channelJevItems(c.id)] },
    {
      items: [
        ...(write && isGroup(c) ? [{ label: 'Rename…', icon: 'edit', run: () => void setDialog({ kind: 'rename', channelId: c.id }) } satisfies MenuItem] : []),
        ...(write ? [{ label: 'Add friends…', icon: 'addPerson', run: () => openAddFriends(c.id) } satisfies MenuItem] : []),
        { label: 'Open in Discord', icon: 'external', run: () => openInDiscord(c) },
      ],
    },
    {
      items: !write
        ? []
        : isGroup(c)
          ? [{ label: 'Leave group…', icon: 'leave', danger: true, run: () => void setDialog({ kind: 'leave', channelId: c.id }) }]
          : [{ label: 'Close DM', icon: 'close', danger: true, run: () => act('list', c.id, () => api.discord.closeDm(c.id, false)) }],
    },
  ];
}

/** The owner is the group's owner: Discord leaves the owner out of a known roster only when it is the owner. */
const ownerIsSelf = (c: DmChannel): boolean => c.dm.rosterKnown && c.dm.ownerId !== null && !c.dm.recipients.some((r) => r.id === c.dm.ownerId);

/** The chat bar's members flyout: the owner marked by a crown, then adding friends (posting unlocked); removing people stays in Discord. */
export function membersMenu(c: DmChannel): MenuGroup[] {
  const owner = (id: string | null): Pick<MenuItem, 'icon' | 'detail'> => (id !== null && id === c.dm.ownerId ? { icon: 'crown', detail: 'Group owner' } : { icon: 'person' });
  const you: MenuItem = { label: 'You', ...(ownerIsSelf(c) ? { icon: 'crown', detail: 'Group owner' } : { icon: 'person' }), run: () => undefined };
  const manage = manageable(c);
  const count = memberCount(c);
  return [
    {
      heading: count === null ? 'Members unknown' : `Members · ${count}`,
      items: [you, ...c.dm.recipients.map((r): MenuItem => ({ label: r.name, ...owner(r.id), run: () => openPerson(r.id) }))],
    },
    {
      items: [
        ...(manage && postingUnlocked()
          ? [{ label: 'Add friends…', icon: 'addPerson', ...(count === null ? {} : { detail: `${count} of ${GROUP_DM_MAX_MEMBERS}` }), run: () => openAddFriends(c.id) } satisfies MenuItem]
          : []),
        ...(manage && ownerIsSelf(c) ? [{ label: 'Remove people in Discord', icon: 'external', run: () => openInDiscord(c) } satisfies MenuItem] : []),
      ],
    },
  ];
}
