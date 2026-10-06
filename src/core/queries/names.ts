/** SQL name fallback: server nickname, display name, username, id. Caller joins users u for userId; channelId supplies server context. */
export const displayNameSql = (userId: string, channelId: string): string =>
  `COALESCE((SELECT mem.nick FROM members mem JOIN channels mc ON mc.guild_id = mem.guild_id WHERE mc.id = ${channelId} AND mem.user_id = ${userId}), u.global_name, u.username, ${userId})`;

/** The server feature (Enhanced Role Styles, a boost perk) under which Discord draws a role's gradient. */
const ENHANCED_ROLE_COLORS = 'ENHANCED_ROLE_COLORS';

/** One value from the member's highest role (in the channel's server) matching `where`; roles are `r`. */
const topRoleSql = (userId: string, channelId: string, value: string, where: string): string =>
  `(SELECT ${value} FROM members mem JOIN channels mc ON mc.guild_id = mem.guild_id JOIN json_each(mem.roles) j JOIN roles r ON r.id = j.value
    WHERE mc.id = ${channelId} AND mem.user_id = ${userId} AND ${where} ORDER BY r.position DESC, r.id LIMIT 1)`;

/** 0xRRGGBB of the person's highest coloured role in the channel's server; NULL for none. The query needn't join users. */
export const roleColorSql = (userId: string, channelId: string): string => topRoleSql(userId, channelId, 'r.color', 'r.color != 0');

/** Selects highest colored role’s primary/secondary/tertiary colors and server gradient eligibility. nameStyle.ts decodes them. */
export const roleStyleSql = (userId: string, channelId: string): string =>
  `${topRoleSql(userId, channelId, "json_array(r.color, json_extract(r.raw_json, '$.colors.secondary_color'), json_extract(r.raw_json, '$.colors.tertiary_color'))", 'r.color != 0')} AS roleColorsJson,
   EXISTS (SELECT 1 FROM channels gc JOIN guilds g ON g.id = gc.guild_id JOIN json_each(g.features) f
           WHERE gc.id = ${channelId} AND f.value = '${ENHANCED_ROLE_COLORS}') AS enhancedRoles`;

/**
 * What Discord draws with a person's name in a server (AuthorStyle), as columns roleStyleSql's, roleIconJson,
 * tagGuildId, tag, tagBadge, nameStyle and decoration. The query must join `users u`.
 */
export const authorStyleSql = (userId: string, channelId: string): string =>
  `${roleStyleSql(userId, channelId)},
   u.name_style AS nameStyle, u.decoration,
   ${topRoleSql(userId, channelId, "json_object('roleId', r.id, 'name', r.name, 'icon', r.icon, 'emoji', r.unicode_emoji)", '(r.icon IS NOT NULL OR r.unicode_emoji IS NOT NULL)')} AS roleIconJson,
   u.tag_guild_id AS tagGuildId, u.tag, u.tag_badge AS tagBadge`;

/** SQL name fallback without server context: display name, username, id. Caller joins users u for userId. */
export const plainNameSql = (userId: string): string => `COALESCE(u.global_name, u.username, ${userId})`;
