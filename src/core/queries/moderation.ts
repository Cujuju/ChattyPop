// Where the owner moderates: Manage Messages in a channel (a thread's parent's), as Discord decides "On servers I moderate".
import { DM_GUILD_ID, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { can, PERMISSIONS } from '@shared/permissions';
import type { Db } from '../db';
import { accessOf, memberFacts } from './mentions';

/** Whether `selfId` may manage messages in `channelId`; false in DMs, for an unknown channel or before the owner is known. */
export function ownerModerates(db: Db, selfId: string | null, channelId: string): boolean {
  if (selfId === null) return false;
  const ch = db.prepare('SELECT guild_id AS guildId, kind, parent_id AS parentId FROM channels WHERE id = ?').get(channelId) as
    | { guildId: string; kind: number; parentId: string | null }
    | undefined;
  if (!ch || ch.guildId === DM_GUILD_ID) return false;
  const thread = THREAD_CHANNEL_TYPES.has(ch.kind) && ch.parentId !== null;
  const access = accessOf(db, ch.guildId, thread ? ch.parentId! : channelId, thread);
  return can(access, selfId, memberFacts(db, ch.guildId, selfId), PERMISSIONS.MANAGE_MESSAGES);
}