import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { AppEvent, DirectoryChannel, DirectoryGuild, ReadStateCount } from '@shared/contract';
import { DM_CHANNEL_TYPES, DM_GUILD_ID, THREAD_CHANNEL_TYPES, byDmActivity, compareSnowflakes } from '@shared/discord';
import { PRIVATE_THREAD_TYPE } from '@shared/permissions';
import { chatUnreadCount } from '@shared/unread';
import { onAppEvent } from './events';
import { unreadCounts } from './unreadCounts';

/** An in-place change to the directory an event carries, instead of reading it all again. */
type Patch = (guilds: DirectoryGuild[]) => DirectoryGuild[];
/** Patches since the newest directory read began: its answer may predate them, so they apply to it again. */
let sinceRead: Patch[] | null = null;

async function readDirectory(): Promise<DirectoryGuild[]> {
  const patches: Patch[] = [];
  sinceRead = patches;
  try {
    const guilds = await api.core.directory();
    return patches.reduce((g, patch) => patch(g), guilds);
  } finally {
    if (sinceRead === patches) sinceRead = null;
  }
}

/** Servers and channels known to the archive, with opt-in flags and stored-message counts. */
export const [directory, { refetch: refetchDirectory, mutate: mutateDirectory }] = createResource(readDirectory, { initialValue: [] });

function patchDirectory(patch: Patch): void {
  sinceRead?.push(patch);
  mutateDirectory(patch);
}

/** A DM's newest message rises to `lastMessageId` (never falls), and the DMs keep Discord's order. */
const raiseDmActivity =
  (channelId: string, lastMessageId: string): Patch =>
  (guilds) =>
    guilds.map((g) =>
      g.id !== DM_GUILD_ID
        ? g
        : {
            ...g,
            channels: g.channels
              .map((c) =>
                c.id === channelId && c.dm && (!c.dm.lastMessageId || compareSnowflakes(lastMessageId, c.dm.lastMessageId) > 0)
                  ? { ...c, dm: { ...c.dm, lastMessageId } }
                  : c,
              )
              .sort(byDmActivity),
          },
    );

/** Each listed channel takes the read state fields `states` carry; a field left out keeps its value, as core does. */
const applyReadStates =
  (states: ReadStateCount[]): Patch =>
  (guilds) => {
    const byId = new Map(states.map((s) => [s.channelId, s]));
    const apply = (c: DirectoryChannel): DirectoryChannel => {
      const s = byId.get(c.id);
      if (!s) return c;
      const dm = c.dm && {
        ...c.dm,
        ...(s.ackId !== undefined ? { ackId: s.ackId } : {}),
        ...(s.muteEndsMs !== undefined ? { muteEndsMs: s.muteEndsMs } : {}),
      };
      return { ...c, ...(s.mentionCount !== undefined ? { mentionCount: s.mentionCount } : {}), ...(dm ? { dm } : {}) };
    };
    return guilds.map((g) => (g.channels.some((c) => byId.has(c.id)) ? { ...g, channels: g.channels.map(apply) } : g));
  };

onAppEvent('archive-changed', () => void refetchDirectory());
onAppEvent('dm-activity', (e) => patchDirectory(raiseDmActivity(e.channelId, e.lastMessageId)));
onAppEvent('read-states-changed', (e) => patchDirectory(applyReadStates(e.states)));

/** Discord's unread chat, from the read states above: the host's counted 'chat' source. Not a panel id, so no panel dot. */
unreadCounts.host('discord-chat', { kind: 'chat', count: () => chatUnreadCount(directory()) });

/** Threads and forum posts are archived with their parent channel and listed under it, not as channels. */
export const isThread = (c: DirectoryChannel): boolean => THREAD_CHANNEL_TYPES.has(c.kind);
/** Only those added to it and moderators see it; other threads are public to whoever sees their channel. */
export const isPrivateThread = (c: DirectoryChannel): boolean => c.kind === PRIVATE_THREAD_TYPE;
/** Shown on a private thread: who can see it. */
export const PRIVATE_THREAD_HINT = 'Private thread: only people added to it and moderators can see it';

/** '@' for a DM or group DM, '#' for a server channel. */
export const channelSigil = (c: DirectoryChannel): string => (DM_CHANNEL_TYPES.has(c.kind) ? '@' : '#');

/** An archived channel with its server's name. */
export type ArchivedChannel = DirectoryChannel & { guildName: string };

/** Archived channels in directory order: threads only when `threads`, and no local-AI-only ones when `hostedAi` (Jev reads them). */
export const archivedChannels = (opts: { threads?: boolean; hostedAi?: boolean } = {}): ArchivedChannel[] =>
  directory().flatMap((g) =>
    g.channels.filter((c) => c.optedIn && (opts.threads || !isThread(c)) && !(opts.hostedAi && c.localAiOnly)).map((c) => ({ ...c, guildName: g.name })),
  );

/** '#name' (or '@name' for a DM), then ' · server' when `guildName` is given. */
export const channelLabel = (c: DirectoryChannel, guildName?: string): string => `${channelSigil(c)}${c.name}${guildName ? ` · ${guildName}` : ''}`;

/** A known channel by id. */
export const channelById = (id: string): DirectoryChannel | undefined =>
  directory()
    .flatMap((g) => g.channels)
    .find((c) => c.id === id);

/** Archived threads (and forum posts) of a channel that hold messages, most recently active first. */
export const threadsOf = (parentId: string): DirectoryChannel[] =>
  directory()
    .flatMap((g) => g.channels)
    .filter((c) => isThread(c) && c.optedIn && c.parentId === parentId && c.messageCount > 0)
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
onAppEvent('opt-in-changed', () => void refetchDirectory());
onAppEvent('privacy-changed', () => void refetchDirectory());
// A closed DM's avatar comes from its messages, which needs the owner known: read before READY named them, it had none.
onAppEvent('self-changed', () => void refetchDirectory());

const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set());
/** Guild ids (or '' for the server list) whose directory fetch is in flight. */
export const directoryLoading = loading;

export async function loadDirectory(guildId?: string): Promise<void> {
  const key = guildId ?? '';
  setLoading((s) => new Set(s).add(key));
  try {
    await api.discord.refreshDirectory(guildId);
    await refetchDirectory();
  } finally {
    setLoading((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }
}

export const setChannelOptIn = (channelId: string, on: boolean): Promise<void> => api.discord.setOptIn(channelId, on);

type SyncProgress = Extract<AppEvent, { type: 'sync-progress' }>;
/** Latest sync progress per channel id. */
export const [syncProgress, setSyncProgress] = createStore<Record<string, SyncProgress>>({});
onAppEvent('sync-progress', (e) => setSyncProgress(e.channelId, e));
