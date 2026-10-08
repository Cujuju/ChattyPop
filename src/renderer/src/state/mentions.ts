// What the composer's `@` lists: the archive's answer, kept fresh by identity facts Discord already sends.
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { MentionCandidate } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { api } from '@/api';
import { onAppEvent } from './events';

/** Listed for an `@name` in all, as Discord's autocomplete; typing more narrows them. */
const MENTION_SUGGESTIONS_MAX = 10;
/** Discord's client waits this long after a keystroke before searching members (its member search debounce). */
const MEMBER_REQUEST_DEBOUNCE_MS = 200;

/** Bumped by every name change; and by those that may touch every server (a user's own name); and per server. */
const [anyVersion, setAnyVersion] = createSignal(0);
const [everyServerVersion, setEveryServerVersion] = createSignal(0);
const [serverVersions, setServerVersions] = createStore<Record<string, number>>({});

/**
 * Changes when members, roles or access do (a member search's answer among them): open lists read again. With
 * `guildId`, only for changes that may touch that server; without, for any.
 */
export const membersVersion = (guildId?: string): number =>
  guildId === undefined ? anyVersion() : everyServerVersion() + (serverVersions[guildId] ?? 0);

onAppEvent('archive-changed', (e) => {
  if (!e.namesChanged) return;
  setAnyVersion((v) => v + 1);
  if (!e.nameGuildIds) return void setEveryServerVersion((v) => v + 1);
  for (const id of e.nameGuildIds) setServerVersions(id, (v) => (v ?? 0) + 1);
});

/** Who can see the channel, then @everyone, @here and roles, matching `query`: best match first. */
export const mentionSuggestions = (channelId: string, query: string): Promise<MentionCandidate[]> => api.core.mentionCandidates(channelId, query, MENTION_SUGGESTIONS_MAX);

let requestTimer: ReturnType<typeof setTimeout> | undefined;
/** Drops a member search not yet sent: the `@` text it was for is gone. */
export const cancelMemberRequest = (): void => clearTimeout(requestTimer);

/** Requests optional enrichment once typing pauses; unavailable transports leave the locally known suggestions. */
export function requestMembers(guildId: string, query: string): void {
  cancelMemberRequest();
  if (!guildId || guildId === DM_GUILD_ID || !query.trim()) return;
  // The list remains useful when optional enrichment is unavailable.
  requestTimer = setTimeout(() => void api.discord.requestMembers(guildId, query).catch(() => undefined), MEMBER_REQUEST_DEBOUNCE_MS);
}
