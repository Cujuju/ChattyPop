// Renderer requests that write private channels (docs/dms.md §3.5), all through the one DM service.
import { handleMain } from './mainCalls';
import { MAIN_INVOKE } from '@shared/contract';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import type { DiscordClient } from '../discord/client';
import { DmService } from '../discord/dms';
import type { OwnerSession } from '../discord/ownerSession';
import type { FriendIndex } from '../discord/profiles';
import type { ReadStates } from '../discord/readStates';
import { gatePosting, type PostingGate } from '../plugins/posting';

export interface DmDeps {
  core: CoreClient;
  /** DiscordApi.prompt through the posting lock (postingClient): the owner is waiting. */
  owner: DiscordClient;
  /** The account READY named: a write checked as one account is never sent as another. */
  account: Pick<OwnerSession, 'userId'>;
  /** Each DM write is an owner action, bound to the session proven when it is asked. */
  session: Pick<OwnerSession, 'actions'>;
  friends: FriendIndex;
  readStates: Pick<ReadStates, 'settingsChanged'>;
  /** Every DM write is a posting call (@shared/posting): refused while posting is locked. */
  posting: PostingGate;
}

/** Registers the DM writes and the friend list; returns the service, which /msg shares. */
export function registerDmHandlers(d: DmDeps): DmService {
  const { discord: channels } = MAIN_INVOKE;
  const dms = new DmService({ api: d.owner, core: d.core, account: () => d.account.userId, friends: d.friends, settingsChanged: (s) => d.readStates.settingsChanged(s), diag });
  handleMain(channels.friends, () => d.friends.list());
  const writes = d.session.actions(gatePosting(d.posting, {
    startDm: (recipients: unknown, archive: unknown) => dms.start(recipients, archive),
    dmWith: (userId: unknown) => dms.dmWith(userId),
    addToDm: (channelId: unknown, userIds: unknown, archive: unknown) => dms.add(channelId, userIds, archive),
    closeDm: (channelId: unknown, quietly: unknown) => dms.close(channelId, quietly),
    renameDm: (channelId: unknown, name: unknown) => dms.rename(channelId, name),
    muteDm: (channelId: unknown, window: unknown) => dms.mute(channelId, window),
  }));
  handleMain(channels.startDm, (recipients: unknown, archive: unknown) => writes.startDm(recipients, archive));
  handleMain(channels.dmWith, (userId: unknown) => writes.dmWith(userId));
  handleMain(channels.addToDm, (channelId: unknown, userIds: unknown, archive: unknown) => writes.addToDm(channelId, userIds, archive));
  handleMain(channels.closeDm, (channelId: unknown, quietly: unknown) => writes.closeDm(channelId, quietly));
  handleMain(channels.renameDm, (channelId: unknown, name: unknown) => writes.renameDm(channelId, name));
  handleMain(channels.muteDm, (channelId: unknown, window: unknown) => writes.muteDm(channelId, window));
  return dms;
}
