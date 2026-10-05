import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_CHANNEL_TYPE, DM_CHANNEL_TYPES, DM_GROUP_NAME, DM_GUILD_ID, byDmActivity } from '@shared/discord';
import type { TextTier } from '@shared/settings';
import { LOCAL_ONLY_IDS_SQL } from '../channelPolicy';
import type { Db } from '../db';
import { NOTABLE_QUERY, NOTABLE_SUBJECT } from '../jev/notable';
import { storedMatchSql } from '../jev/queries';
import { dmBlocks, ownPrivateChannelSql } from './dmDirectory';
import { unreadSql } from './readMarks';
import { visibleChannelSql } from './privacy';

/**
 * Servers and channels privacy mode leaves visible; each channel's newCount and notableCount count unread messages
 * (unreadSql: after its read mark and Discord's read state, else after `unseenSince`; none of `readerId`'s own: the
 * account signed in, else the last one); mentionCount is Discord's unread mention count (read_states). A one-to-one DM
 * names its other person for their avatar: the DM list's recipient, else (while its roster is unknown) its newest sender who isn't
 * `selfId`, once the owner is known. DMs are `selfId`'s only, newest activity first, each with its `dm` block.
 */
export function directory(db: Db, unseenSince: number, selfId: string | null = null, readerId: string | null = selfId): DirectoryGuild[] {
  const notable = storedMatchSql(NOTABLE_QUERY, 'j', 'notable_');
  const guilds = db
    .prepare(`SELECT id, name, icon, hide_in_privacy AS hideInPrivacy FROM guilds LEFT JOIN guild_order o ON o.guild_id = guilds.id
       WHERE id NOT IN (SELECT id FROM hidden_ids) ORDER BY id != @dms, o.position IS NULL, o.position, name COLLATE NOCASE`)
    .all({ dms: DM_GUILD_ID }) as {
    id: string;
    name: string;
    icon: string | null;
    hideInPrivacy: number;
  }[];
  const channels = db
    .prepare(
      `SELECT c.id, c.guild_id AS guildId, c.name, c.kind, c.parent_id AS parentId, c.opted_in AS optedIn,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS messageCount,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND ${unreadSql('m', 'c', 'rs')}) AS newCount,
              (SELECT COUNT(*) FROM messages m JOIN jev_judgments j ON j.message_id = m.id AND j.subject = @notable AND ${notable.sql}
               WHERE m.channel_id = c.id AND ${unreadSql('m', 'c', 'rs')}) AS notableCount,
              COALESCE((SELECT mention_count FROM read_states r WHERE r.channel_id = c.id), 0) AS mentionCount,
              (SELECT MAX(ts) FROM messages m WHERE m.channel_id = c.id) AS lastTs,
              c.id IN (${LOCAL_ONLY_IDS_SQL}) AS localAiOnly, c.text_tier AS textTier, c.hide_in_privacy AS hideInPrivacy,
              c.icon, peer.id AS peerId, peer.avatar AS peerAvatar
       FROM channels c
       LEFT JOIN read_states rs ON rs.channel_id = c.id
       -- The CASE runs the message lookup only for a one-to-one DM with neither its person nor its roster kept; a join
       -- condition would run it for every channel.
       LEFT JOIN users peer ON peer.id = COALESCE(c.peer_id, CASE WHEN c.kind = @dm AND c.recipients IS NULL AND @self != '' THEN (SELECT m.author_id FROM messages m
         WHERE m.channel_id = c.id AND m.author_id != @self ORDER BY m.ts DESC LIMIT 1) END)
       WHERE ${visibleChannelSql('c.id')} AND ${ownPrivateChannelSql('c')} ORDER BY c.position, c.name`,
    )
    .all({ unseen: unseenSince, notable: NOTABLE_SUBJECT, dm: DM_CHANNEL_TYPE, self: selfId ?? '', reader: readerId ?? '', ...notable.params }) as {
    id: string;
    guildId: string;
    name: string;
    kind: number;
    parentId: string | null;
    optedIn: number;
    messageCount: number;
    newCount: number;
    notableCount: number;
    mentionCount: number;
    lastTs: number | null;
    localAiOnly: number;
    textTier: TextTier | null;
    hideInPrivacy: number;
    icon: string | null;
    peerId: string | null;
    peerAvatar: string | null;
  }[];
  const dms = dmBlocks(db, channels.filter((c) => DM_CHANNEL_TYPES.has(c.kind)).map((c) => c.id));
  // Direct messages first, and always present so they can be browsed before any are stored.
  const dm = guilds.find((g) => g.id === DM_GUILD_ID) ?? { id: DM_GUILD_ID, name: DM_GROUP_NAME, icon: null, hideInPrivacy: 0 };
  return [dm, ...guilds.filter((g) => g.id !== DM_GUILD_ID)].map((g) => {
    const listed = channels
      .filter((c) => c.guildId === g.id)
      .map(({ peerId, peerAvatar, ...c }): DirectoryChannel => {
        const block = dms.get(c.id);
        return {
          ...c,
          optedIn: c.optedIn === 1,
          localAiOnly: c.localAiOnly === 1,
          hideInPrivacy: c.hideInPrivacy === 1,
          peer: peerId ? { id: peerId, avatar: peerAvatar } : null,
          ...(block ? { dm: block } : {}),
        };
      });
    return { ...g, hideInPrivacy: g.hideInPrivacy === 1, channels: g.id === DM_GUILD_ID ? listed.sort(byDmActivity) : listed };
  });
}
