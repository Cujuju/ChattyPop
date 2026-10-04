// How people's names show in a place, as Discord draws them: in a server, the nickname, role colour or Enhanced
// Role Style and Nitro font (role styles replace Nitro colours there); outside one, the display name and whole Nitro style.
import type { PersonName } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import type { Db } from '../db';
import { displayNameSql, plainNameSql, roleStyleSql } from './names';
import { nitroStyle, roleColors } from './nameStyle';
import { visibleChannelSql } from './privacy';

interface Row {
  id: string;
  name: string;
  roleColorsJson: string | null;
  enhancedRoles: number;
  nameStyle: string | null;
}

export function personNames(db: Db, ids: string[], channelId: string | null): PersonName[] {
  if (!ids.length) return [];
  // A place privacy mode hides lends nothing: no nickname, no role style, no profile context.
  const guildId = channelId
    ? (db.prepare(`SELECT guild_id FROM channels c WHERE c.id = ? AND ${visibleChannelSql('c.id')}`).pluck().get(channelId) as string | null | undefined)
    : undefined;
  const place = guildId === undefined ? null : channelId;
  const inServer = place !== null && guildId !== null && guildId !== DM_GUILD_ID;
  const rows = db
    .prepare(
      `SELECT u.id, ${inServer ? `${displayNameSql('u.id', '@place')} AS name, ${roleStyleSql('u.id', '@place')}` : `${plainNameSql('u.id')} AS name, NULL AS roleColorsJson, 0 AS enhancedRoles`},
              u.name_style AS nameStyle
       FROM users u WHERE u.id IN (SELECT value FROM json_each(@ids))`,
    )
    .all({ ids: JSON.stringify(ids), ...(inServer ? { place } : {}) }) as Row[];
  return rows.map((r) => {
    const nitro = nitroStyle(r.nameStyle);
    const colors = inServer ? roleColors(r.roleColorsJson, r.enhancedRoles === 1) : nitro;
    return { id: r.id, name: r.name, color: colors.color, gradient: colors.gradient, font: nitro.font, effect: inServer ? null : nitro.effect, channelId: place };
  });
}
