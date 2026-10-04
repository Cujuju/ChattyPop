// The sidebar's DM list (docs/dms.md §4.1): the current account's DMs from the directory, searched, filtered and folded.
import { createMemo, createRoot, createSignal } from 'solid-js';
import { DM_GUILD_ID, snowflakeToMs } from '@shared/discord';
import { listAge } from '@/ui/dates';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { oneOf } from '@shared/normalize';
import { now, today } from './clock';
import { directory } from './directory';
import { DM_FILTERS, dmSections, isDmChannel, isMuted, isOpenOneToOne, isUnread, unreadDmCount, type DmChannel, type DmFilter, type DmSections } from './dmRules';

export type { DmChannel, DmFilter };

/** The DM list's search text. */
export const [dmSearch, setDmSearch] = createSignal('');
/** The DM list's filter, restored on start. */
export const [dmFilter, setDmFilter] = createSetting<DmFilter>(SETTINGS_KEYS.dmFilter, DM_FILTERS[0], (v) => oneOf(DM_FILTERS, v, DM_FILTERS[0]));

/** Every DM of the account signed in (core lists only its own), newest activity first. */
export const allDms = createRoot(() => createMemo(() => directory().find((g) => g.id === DM_GUILD_ID)?.channels.filter(isDmChannel) ?? []));

/** The list as searched and filtered, with its Requests and Closed folds. */
export const dmList = createRoot(() => createMemo((): DmSections => dmSections(allDms(), dmSearch(), dmFilter())));

/** Conversations neither closed nor a request: the ones the list shows unfolded. */
export const openDms = (): DmChannel[] => allDms().filter((c) => !c.dm.closed && !c.dm.request);

/** Open, unread, unmuted conversations: the DMs segment's count. */
export const unreadDms = (): number => unreadDmCount(allDms(), now());

/** DMs with Discord's count pending, for the collapsed rail; requests stay out, as in the fold. */
export const mentionedDms = (): DmChannel[] => allDms().filter((c) => c.mentionCount > 0 && !c.dm.request);

export const dmUnread = isUnread;
export const dmMuted = (c: DmChannel): boolean => isMuted(c, now());

/** A one-to-one DM's other person: its roster, else (roster unknown) its face. */
export const dmPerson = (c: DmChannel): { id: string; name: string; avatar: string | null } | null =>
  c.dm.recipients[0] ?? (c.peer ? { id: c.peer.id, name: c.name, avatar: c.peer.avatar } : null);

/** The open one-to-one DMs, requests left out, newest activity first: the client opens these with no request. */
export const openOneToOnes = (): DmChannel[] => allDms().filter(isOpenOneToOne);

/** The owner's open DM with `userId`, from the directory; undefined when there is none. */
export const openDmWith = (userId: string): DmChannel | undefined => openOneToOnes().find((c) => dmPerson(c)?.id === userId);

/** When the DM last had a message ("5m", "Tue"); empty when it has none. */
export const dmAge = (c: DmChannel): string => (c.dm.lastMessageId ? listAge(snowflakeToMs(c.dm.lastMessageId), now(), today()) : '');
