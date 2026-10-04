// Starting conversations (docs/dms.md §4.3, §3.6): the New message window, who it offers, and opening what was started.
// The same window adds friends to a conversation (§4.4).
import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { DM_CHANNEL_TYPE, DM_GUILD_ID } from '@shared/discord';
import type { DmOutcome, Friend } from '@shared/dms';
import { yearDate } from '@/ui/dates';
import { openArchive, openChannel, openLive } from './archive';
import { focusComposer } from './composer';
import { channelById, refetchDirectory } from './directory';
import { dmPerson, openDmWith, openOneToOnes, type DmChannel } from './dms';
import { isDmChannel } from './dmRules';
import { onAppEvent } from './events';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { closeWhenLocked, postingUnlocked } from './posting';

const [open, setOpen] = createSignal(false);
/** The conversation friends are being added to; null for a new one. */
const [addTo, setAddTo] = createSignal<string | null>(null);
/** Each opening (or closing) of the window: an opening starts afresh. */
const [session, setSession] = createSignal(0);
/** Whether a new conversation is archived from the start; the window's last choice, restored on start. */
export const [archiveNewConversations, setArchiveNewConversations] = createSetting<boolean>(SETTINGS_KEYS.newMessageArchive, true, (v) => v !== false);
export const newMessageOpen = open;
export const newMessageSession = session;
/** Opens the window afresh; never while posting is locked (closeWhenLocked below closes it on locking). */
const begin = (target: string | null): void => {
  if (!postingUnlocked()) return;
  setAddTo(target);
  setOpen(true);
  setSession(session() + 1);
};
export const openNewMessage = (): void => begin(null);
/** Opens the window to add friends to `channelId`; on a one-to-one DM they make a new group with its person. */
export const openAddFriends = (channelId: string): void => begin(channelId);
export const closeNewMessage = (): void => {
  setOpen(false);
  setSession(session() + 1);
};
closeWhenLocked(open, closeNewMessage);
/** Keeps the open window, now adding to `channelId`: where an add that stopped part way put the others. */
export const retargetAddFriends = (channelId: string): void => void setAddTo(channelId);
/** The window adds to a conversation rather than starting one. */
export const addingFriends = (): boolean => addTo() !== null;

/** The conversation being added to, from the directory; undefined for a new one (or once it is gone). */
export const addTarget = (): DmChannel | undefined => {
  const id = addTo();
  const c = id ? channelById(id) : undefined;
  return c && isDmChannel(c) ? c : undefined;
};

/** Who is in `c` besides the owner: its roster, else a one-to-one DM's person. */
export const memberIds = (c: DmChannel): string[] => {
  const person = dmPerson(c);
  return c.dm.recipients.length ? c.dm.recipients.map((r) => r.id) : person ? [person.id] : [];
};

/** A one-to-one DM becomes a new group when friends are added (Discord answers with that group). */
export const makesGroup = (c: DmChannel): boolean => c.kind === DM_CHANNEL_TYPE;

/** The owner's friends, read each time the window opens (main keeps them current from the gateway). */
const [friends, { mutate: setFriends, refetch: refetchFriends }] = createResource(() => open() || undefined, () => api.discord.friends(), {
  initialValue: [],
});
// Another account's friends never show: dropped at once, then read again if the window is open.
onAppEvent('self-changed', () => {
  setFriends([]);
  void refetchFriends();
});

/** Someone the window offers: a person with an open one-to-one DM, or a friend. */
export interface Candidate {
  id: string;
  name: string;
  avatar: string | null;
  /** Their username and since when a friend, or that only a DM ties them to the owner. */
  detail: string;
  /** Only friends can be in a group (Discord's rule). */
  friend: boolean;
  /** Their open one-to-one DM: opening it sends nothing. */
  dmId: string | null;
  section: 'dms' | 'friends';
}

const friendDetail = (f: Friend): string => (f.since ? `${f.username} · friend since ${yearDate(f.since)}` : f.username);

/**
 * People matching `query` (name or username): those with an open DM first, in Discord's order, then the other friends by
 * name; each once, and none in `exclude`.
 */
export function candidates(query: string, exclude: ReadonlySet<string> = new Set()): Candidate[] {
  const byId = new Map(friends().map((f) => [f.id, f]));
  const seen = new Set(exclude);
  const out: Candidate[] = [];
  for (const c of openOneToOnes()) {
    const p = dmPerson(c);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const f = byId.get(p.id);
    out.push({ id: p.id, name: f?.name ?? p.name, avatar: f?.avatar ?? p.avatar, detail: f ? friendDetail(f) : 'Direct message', friend: !!f, dmId: c.id, section: 'dms' });
  }
  for (const f of friends()) {
    if (seen.has(f.id)) continue;
    out.push({ id: f.id, name: f.name, avatar: f.avatar, detail: friendDetail(f), friend: true, dmId: null, section: 'friends' });
  }
  const q = query.trim().toLocaleLowerCase();
  return q ? out.filter((p) => `${p.name}\n${p.detail}`.toLocaleLowerCase().includes(q)) : out;
}

/**
 * Picks a write is sending, and picks Discord gave no clear answer for (they may exist): neither is sent again. Kept
 * here, not in the window, so closing and reopening it can't send them twice; another account's are dropped.
 */
const [sending, setSending] = createSignal<ReadonlySet<string>>(new Set());
const [unconfirmed, setUnconfirmed] = createSignal<ReadonlySet<string>>(new Set());
const withKey = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};
onAppEvent('self-changed', () => void setUnconfirmed(new Set<string>()));

/**
 * Enter in the To field picks the highlighted person, as Forward's Enter picks its highlighted target; it sends only with
 * no one highlighted (an empty list), or with Ctrl (or Cmd).
 */
export const enterSends = (e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>, highlighted: boolean): boolean => e.ctrlKey || e.metaKey || !highlighted;

/** What a write is for: the conversation added to (none: a start) and the people, in any order. */
export const pickKey = (addingTo: string | null, people: readonly string[]): string => `${addingTo ?? 'new'}:${[...people].sort().join(',')}`;
/** A write for these picks is in flight. */
export const pickSending = (key: string): boolean => sending().has(key);
/** A write for these picks got no clear answer: sending them again could make the conversation twice. */
export const pickUnconfirmed = (key: string): boolean => unconfirmed().has(key);

/** §4.3: an archived conversation opens in the Archive with the typing in its composer; any other in the live client. */
async function showConversation(channelId: string, opening: number): Promise<void> {
  await refetchDirectory();
  // The window closed (or opened afresh) while this was sent: nothing opens.
  if (session() !== opening) return;
  if (channelById(channelId)?.optedIn) {
    await openArchive(channelId);
    focusComposer();
  } else openLive({ id: channelId, guildId: DM_GUILD_ID });
}

/**
 * Starts a conversation with `people` (one person's open DM sends nothing), or adds them to `addTo`; main archives or
 * declines a conversation this makes as it stores it. What it leads to is shown, unless the window closed meanwhile; a
 * group added to shows its new members, and an add that stopped part way keeps the window. An `uncertain` outcome shows
 * nothing, and its picks are never sent again.
 */
export async function sendPicks(addTo: DmChannel | undefined, people: string[], archive: boolean): Promise<DmOutcome> {
  const key = pickKey(addTo?.id ?? null, people);
  // One person with an open DM sends nothing, so only a request is held back.
  const sendsRequest = addTo !== undefined || people.length !== 1 || !openDmWith(people[0]!);
  if (sendsRequest && (pickSending(key) || pickUnconfirmed(key))) throw new Error('These people were just sent: wait for Discord, or check it.');
  const opening = session();
  setSending(withKey(sending(), key, true));
  try {
    const outcome = addTo ? await api.discord.addToDm(addTo.id, people, archive) : await api.discord.startDm(people, archive);
    if (outcome.kind === 'uncertain') setUnconfirmed(withKey(unconfirmed(), key, true));
    else if (outcome.failed || (addTo && outcome.kind === 'opened')) await refetchDirectory();
    else await showConversation(outcome.channelId, opening);
    return outcome;
  } finally {
    setSending(withKey(sending(), key, false));
  }
}

/** The profile's Message (§3.6): their open DM from the directory, else a new one; shown as a sidebar pick shows it. */
export async function messagePerson(userId: string): Promise<void> {
  let channelId = openDmWith(userId)?.id;
  if (!channelId) {
    channelId = await api.discord.dmWith(userId);
    await refetchDirectory();
  }
  openChannel({ id: channelId, guildId: DM_GUILD_ID });
}
