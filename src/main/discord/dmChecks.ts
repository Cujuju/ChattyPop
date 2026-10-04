// What main checks a DM write against before sending it (docs/dms.md §3.5): who it is with, Discord's cap, friendship,
// and the conversation's state.
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, snowflakeArg, type RawUser } from '@shared/discord';
import { GROUP_DM_MAX_MEMBERS, GROUP_DM_NAME_MAX, type PrivateChannelFacts } from '@shared/dms';

/** The cap counts the owner with the people picked. */
const OWNER = 1;
/** A one-to-one DM's roster: its other person, counted even while unknown. */
const ONE_TO_ONE_OTHERS = 1;

/** The owner's friends: only friends can be in a group (Discord's rule); their user rows join a roster. */
export interface Friends {
  isFriend(userId: string): boolean;
  user(userId: string): RawUser | undefined;
}

/** The people `ids` names: snowflakes, each once, never the owner. */
export function checkPeople(ids: unknown, self: string): string[] {
  if (!Array.isArray(ids)) throw new Error('Pick who to message.');
  const people = [...new Set(ids.map((id) => snowflakeArg(id, 'user')))];
  if (people.includes(self)) throw new Error("You're in it already: pick other people.");
  return people;
}

/** `members` (the owner included) fit Discord's cap. */
export function checkCap(members: number): void {
  if (members > GROUP_DM_MAX_MEMBERS) throw new Error(`A group holds up to ${GROUP_DM_MAX_MEMBERS} people, you included.`);
}

/** Every one of `ids` is a friend. */
export function checkFriends(ids: readonly string[], friends: Pick<Friends, 'isFriend'>): void {
  if (ids.some((id) => !friends.isFriend(id))) throw new Error('Only friends can be in a group.');
}

/** Who a new conversation is with: one person (anyone Discord lets the owner message), or a group of friends. */
export function checkStart(recipients: unknown, self: string, friends: Pick<Friends, 'isFriend'>): string[] {
  const people = checkPeople(recipients, self);
  if (!people.length) throw new Error('Pick who to message.');
  if (people.length > 1) checkFriends(people, friends);
  checkCap(people.length + OWNER);
  return people;
}

/** A conversation the owner can manage: open, and no message request (read-only until accepted in Discord). */
export const checkManageable = (f: PrivateChannelFacts): void => {
  if (f.closed) throw new Error('This conversation is closed.');
  if (f.request) throw new Error('A message request is read-only here: accept it in Discord first.');
};

/**
 * Who joins an open conversation (no request): friends not in it yet, within the cap with those there. A one-to-one DM
 * becomes a group.
 */
export function checkAdd(f: PrivateChannelFacts, ids: unknown, self: string, friends: Pick<Friends, 'isFriend'>): string[] {
  checkManageable(f);
  if (f.kind === GROUP_DM_CHANNEL_TYPE && f.recipients === null) throw new Error("This group's members aren't known yet: try again once Discord has loaded it.");
  const members = f.recipients ?? [];
  const added = checkPeople(ids, self).filter((id) => !members.includes(id));
  if (!added.length) throw new Error('Pick someone not in this conversation.');
  checkFriends(added, friends);
  checkCap((f.kind === DM_CHANNEL_TYPE ? Math.max(members.length, ONE_TO_ONE_OTHERS) : members.length) + added.length + OWNER);
  return added;
}

/** An open group's new name, trimmed; a one-to-one DM has none of its own. */
export function checkRename(f: PrivateChannelFacts, name: unknown): string {
  if (f.kind !== GROUP_DM_CHANNEL_TYPE) throw new Error('Only a group can be renamed.');
  checkManageable(f);
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error('Name the group.');
  if (n.length > GROUP_DM_NAME_MAX) throw new Error(`A group name is at most ${GROUP_DM_NAME_MAX} characters.`);
  return n;
}

/** The owner's archive choice for a conversation a write may make; undefined: none (the profile's Message, /msg). */
export function checkArchiveChoice(v: unknown): boolean | undefined {
  if (v !== undefined && typeof v !== 'boolean') throw new Error('Archive it, or not.');
  return v;
}
