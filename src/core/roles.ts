// Each server's roles, as the gateway reports them: they set the colour and icon Discord draws beside a member's name.
import type { RawRole } from '@shared/discord';
import type { Db } from './db';

const put = (db: Db, guildId: string, r: RawRole): void =>
  void db
    .prepare(
      `INSERT INTO roles (id, guild_id, name, position, color, icon, unicode_emoji, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET guild_id = excluded.guild_id, name = excluded.name, position = excluded.position, color = excluded.color,
         icon = excluded.icon, unicode_emoji = excluded.unicode_emoji, raw_json = excluded.raw_json`,
    )
    .run(r.id, guildId, r.name, r.position ?? 0, r.color ?? 0, r.icon ?? null, r.unicode_emoji ?? null, JSON.stringify(r));

/** A change to the stored roles: a server's whole list (READY, GUILD_CREATE: roles missing from it were deleted), one role, or a deletion. */
export type RoleChange = { kind: 'replace'; guildId: string; roles: RawRole[] } | { kind: 'put'; guildId: string; role: RawRole } | { kind: 'delete'; roleId: string };

export function applyRoleChange(db: Db, c: RoleChange): void {
  if (c.kind === 'delete') return void db.prepare('DELETE FROM roles WHERE id = ?').run(c.roleId);
  if (c.kind === 'put') return put(db, c.guildId, c.role);
  db.transaction(() => {
    db.prepare('DELETE FROM roles WHERE guild_id = ? AND id NOT IN (SELECT value FROM json_each(?))').run(c.guildId, JSON.stringify(c.roles.map((r) => r.id)));
    for (const r of c.roles) put(db, c.guildId, r);
  })();
}
