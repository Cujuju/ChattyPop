import { createSignal } from 'solid-js';
import type { DirectoryGuild } from '@shared/contract';

const [guilds, setGuilds] = createSignal<ReadonlyMap<string, string>>(new Map());
/** Host directory reads publish the same channel membership for desktop and phone dependency scopes. */
export function setArchiveDirectory(directory: readonly DirectoryGuild[]): void {
  setGuilds(new Map(directory.flatMap((g) => g.channels.map((c) => [c.id, g.id] as const))));
}
export const archiveGuild = (channelId: string): string | undefined => guilds().get(channelId);
