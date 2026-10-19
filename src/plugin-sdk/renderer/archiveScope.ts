import { createSignal } from 'solid-js';
import { THREAD_CHANNEL_TYPES } from '@shared/discord';
import type { DirectoryGuild } from '@shared/contract';

const [parents, setParents] = createSignal<ReadonlyMap<string, string>>(new Map());
const [guilds, setGuilds] = createSignal<ReadonlyMap<string, string>>(new Map());
/** Host directory reads publish the same channel membership for desktop and phone dependency scopes. */
export function setArchiveDirectory(directory: readonly DirectoryGuild[]): void {
  setParents(new Map(directory.flatMap((g) => g.channels.flatMap((c) => c.parentId && THREAD_CHANNEL_TYPES.has(c.kind) ? [[c.id, c.parentId] as const] : []))));
  setGuilds(new Map(directory.flatMap((g) => g.channels.map((c) => [c.id, g.id] as const))));
}
export const archiveParent = (channelId: string): string | undefined => parents().get(channelId);
export const archiveGuild = (channelId: string): string | undefined => guilds().get(channelId);
