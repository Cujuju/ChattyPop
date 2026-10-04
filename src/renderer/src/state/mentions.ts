// What the composer's `@` lists: the archive's answer, kept fresh as Discord sends the members it is asked for.
import { createSignal } from 'solid-js';
import type { MentionCandidate } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { api } from '@/api';
import { onAppEvent } from './events';

/** Listed for an `@name` in all, as Discord's autocomplete; typing more narrows them. */
const MENTION_SUGGESTIONS_MAX = 10;
/** Discord's client waits this long after a keystroke before searching members (its member search debounce). */
const MEMBER_REQUEST_DEBOUNCE_MS = 200;

const [membersVersion, setMembersVersion] = createSignal(0);
/** Changes when members or roles do (a member search's answer among them): open lists read again. */
export { membersVersion };
onAppEvent('archive-changed', (e) => {
  if (e.namesChanged) setMembersVersion((v) => v + 1);
});

/** Who can see the channel, then @everyone, @here and roles, matching `query`: best match first. */
export const mentionSuggestions = (channelId: string, query: string): Promise<MentionCandidate[]> => api.core.mentionCandidates(channelId, query, MENTION_SUGGESTIONS_MAX);

let requestTimer: ReturnType<typeof setTimeout> | undefined;
/** Drops a member search not yet sent: the `@` text it was for is gone. */
export const cancelMemberRequest = (): void => clearTimeout(requestTimer);

/** Asks Discord for the server's members starting with `query` once typing pauses; a DM's people are all known. */
export function requestMembers(guildId: string, query: string): void {
  cancelMemberRequest();
  if (!guildId || guildId === DM_GUILD_ID || !query.trim()) return;
  // Unanswered, the list keeps the members the archive knows; main logs why.
  requestTimer = setTimeout(() => void api.discord.requestMembers(guildId, query).catch(() => undefined), MEMBER_REQUEST_DEBOUNCE_MS);
}
