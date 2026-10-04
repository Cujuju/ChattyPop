// Core methods over the archive itself: directory, channels, ingest and sync, message pages.
import type { AppEvent, CoreMethods } from '@shared/contract';
import type { Archive } from './archive';
import type { Db } from './db';
import { applyGatewayEvent, type GatewayDeps } from './gatewayEvents';
import { directory } from './queries/directory';
import { messagePage, messagesByIds } from './queries/messages';
import { privacyScope, visibleChannelIds } from './queries/privacy';
import { markViewed, newestMessageId } from './queries/readMarks';
import { putReadStates } from './queries/readStates';
import { applyAccessFacts } from './access';
import { ARRIVAL } from './arrival';
import { archiveRefusal, dmLastMessageId, openDmWith, privateChannelFacts, privateChannelIds, setAutoDeclined } from './privateChannels';

type Handlers = Pick<
  CoreMethods,
  | 'directory'
  | 'markChannelViewed'
  | 'markDmRead'
  | 'upsertGuilds'
  | 'upsertChannels'
  | 'setOptIn'
  | 'optedInChannels'
  | 'optedInDms'
  | 'syncable'
  | 'upsertThreads'
  | 'channelInfo'
  | 'replacePrivateChannels'
  | 'privateChannel'
  | 'dmWith'
  | 'applyDmWrite'
  | 'privateChannelIds'
  | 'setChannelPolicy'
  | 'setGuildHideInPrivacy'
  | 'privacyScope'
  | 'ingestMessages'
  | 'applyGatewayEvent'
  | 'replaceGuildRoles'
  | 'applyAccessFacts'
  | 'putReadStates'
  | 'syncState'
  | 'reconcileDeletes'
  | 'messagePage'
  | 'messageById'
  | 'applyOwnReaction'
  | 'ingestSyncPage'
>;

export function archiveHandlers(o: {
  ready: () => { db: Db; archive: Archive };
  emit: (e: AppEvent) => void;
  /** An archive write touched this channel ('' = none in particular); coalesced into one UI refresh. */
  noteChanged: (channelId: string) => void;
  /** Start of the history window sync fills. */
  backfillFromMs: () => number;
  /** The signed-in user; null until main has said. */
  selfId: () => string | null;
  /** End of the previous app session. */
  lastSeenAt: () => number;
  /** Re-applies text retention (a channel's tier changed). */
  applyTextTier: () => Promise<void>;
  /** When auto-archiving DMs was turned on (ms); null while off. */
  autoArchiveSinceMs: () => number | null;
}): Handlers {
  const archive = (): Archive => o.ready().archive;
  const gatewayDeps: GatewayDeps = {
    changed: o.noteChanged,
    backfillFromMs: o.backfillFromMs,
    selfId: o.selfId,
    dmActivity: (channelId, lastMessageId) => {
      if (visibleChannelIds(o.ready().db, [channelId]).has(channelId)) o.emit({ type: 'dm-activity', channelId, lastMessageId });
    },
    autoArchiveSinceMs: o.autoArchiveSinceMs,
    optedIn: (channelId) => o.emit({ type: 'opt-in-changed', optedIn: channelId }),
  };
  /** Archives a channel or stops (a DM taken out is declined for auto-archive); a DM must be one the account may archive. */
  const setArchiving = (channelId: string, on: boolean): void => {
    const refused = on ? archiveRefusal(o.ready().db, channelId, o.selfId()) : null;
    if (refused) throw new Error(refused);
    archive().setOptIn(channelId, on);
    setAutoDeclined(o.ready().db, channelId, !on);
    o.emit({ type: 'opt-in-changed', ...(on ? { optedIn: channelId } : {}) });
  };
  return {
    directory: () => directory(o.ready().db, o.lastSeenAt(), o.selfId()),
    markChannelViewed: (channelId) => {
      const db = o.ready().db;
      const unread = markViewed(db, channelId, Date.now(), o.lastSeenAt(), o.selfId());
      // Read here is read on Discord: main acknowledges it, as Discord's client does for a channel it shows.
      const messageId = newestMessageId(db, channelId);
      if (messageId) o.emit({ type: 'channel-read', channelId, messageId });
      return unread;
    },
    markDmRead: (channelId) => {
      const db = o.ready().db;
      const last = dmLastMessageId(db, channelId, o.selfId());
      if (last === undefined) throw new Error('Not a direct message of the account signed in.');
      markViewed(db, channelId, Date.now(), o.lastSeenAt(), o.selfId());
      // Discord's newest, not the newest stored: an unarchived DM acks too.
      const messageId = last ?? newestMessageId(db, channelId);
      if (messageId) o.emit({ type: 'channel-read', channelId, messageId });
    },
    upsertGuilds: (guilds) => archive().upsertGuilds(guilds),
    upsertChannels: (guildId, channels) => archive().upsertChannels(guildId, channels),
    setOptIn: (channelId, on) => setArchiving(channelId, on),
    optedInChannels: () => archive().optedInChannels(o.selfId()),
    optedInDms: () => archive().optedInChannels(o.selfId(), true),
    syncable: (channelId) => archive().syncable(channelId, o.selfId()),
    upsertThreads: (threads) => {
      const stale = archive().upsertThreads(threads, o.backfillFromMs());
      if (threads.length) o.noteChanged('');
      return stale;
    },
    channelInfo: (channelId) => archive().channelInfo(channelId),
    replacePrivateChannels: (selfId, channels, partial) => {
      archive().replacePrivateChannels(selfId, channels, partial, Date.now());
      o.noteChanged('');
    },
    privateChannel: (channelId) => privateChannelFacts(o.ready().db, channelId, o.selfId()),
    dmWith: (userId) => openDmWith(o.ready().db, userId, o.selfId()),
    setChannelPolicy: (channelId, policy) => {
      archive().setChannelPolicy(channelId, policy);
      o.emit({ type: 'opt-in-changed' }); // the channel list shows the policy
      if (policy.textTier !== undefined) void o.applyTextTier();
      if (policy.hideInPrivacy !== undefined) o.emit({ type: 'privacy-changed' });
    },
    setGuildHideInPrivacy: (guildId, on) => {
      archive().setGuildHideInPrivacy(guildId, on);
      o.emit({ type: 'privacy-changed' });
    },
    privacyScope: () => privacyScope(o.ready().db),
    // Main sends fetched pages here (the startup re-check), never gateway events.
    ingestMessages: (messages) => {
      const r = archive().ingestMessages(messages, ARRIVAL.sync);
      new Set(messages.map((m) => m.channel_id)).forEach(o.noteChanged);
      return r;
    },
    applyGatewayEvent: (t, d) => applyGatewayEvent(archive(), t, d, gatewayDeps),
    applyDmWrite: (accountId, t, d, archiving) => {
      // Core takes calls in order: a READY for another account, seen first, has already named it here.
      if (o.selfId() !== accountId) return false;
      applyGatewayEvent(archive(), t, d, { ...gatewayDeps, selfId: () => accountId });
      // In the same call as the store: no MESSAGE_CREATE for it is applied in between to auto-archive it.
      if (archiving !== undefined) setArchiving((d as { id: string }).id, archiving);
      return true;
    },
    privateChannelIds: () => privateChannelIds(o.ready().db),
    replaceGuildRoles: (guildId, roles) => {
      archive().applyRoleChange({ kind: 'replace', guildId, roles });
    },
    applyAccessFacts: (f) => {
      // A change to who can see a channel reports itself, as name data does (nameWrites.ts).
      applyAccessFacts(o.ready().db, f, Date.now());
    },
    putReadStates: (counts, replace) => {
      const db = o.ready().db;
      putReadStates(db, counts, replace);
      // READY's replace every channel's: the list is read again. Others patch rows in place, never for a hidden channel.
      if (replace) return o.noteChanged('');
      const visible = visibleChannelIds(db, counts.map((c) => c.channelId));
      const states = counts.filter((c) => visible.has(c.channelId));
      if (states.length) o.emit({ type: 'read-states-changed', states });
    },
    applyOwnReaction: (r) => {
      const self = o.selfId();
      const event = { channel_id: r.channelId, message_id: r.messageId, emoji: r.emoji, user_id: self ?? undefined };
      // Unknown self: the gateway's copy applies it alone.
      if (self && archive().applyReaction(r.add ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE', event, self)) o.noteChanged(r.channelId);
    },
    syncState: (channelId) => archive().syncState(channelId),
    reconcileDeletes: (channelId, seenIds, sinceTs, untilTs) => {
      const n = archive().reconcileDeletes(channelId, seenIds, sinceTs, untilTs, Date.now());
      if (n) o.noteChanged(channelId);
      return n;
    },
    messagePage: (q) => messagePage(o.ready().db, q),
    messageById: (messageId) => messagesByIds(o.ready().db, [messageId])[0] ?? null,
    ingestSyncPage: (channelId, page, direction, reachedEnd) => {
      const r = archive().ingestSyncPage(channelId, page, direction, reachedEnd);
      if (page.length) o.noteChanged(channelId);
      return r;
    },
  };
}
