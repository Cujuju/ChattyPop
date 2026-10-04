// What decides who can see a channel (shared/permissions.ts): each server's owner and each channel's overwrites, as
// the gateway reports them; members' roles are kept with their nicknames (people.ts).
import type { AccessFacts } from '@shared/permissions';
import type { Db } from './db';
import { putMember } from './people';

/**
 * Stores owners, overwrites and the owner's roles. A named server not yet archived is added (READY can precede the
 * server list); channels not yet archived are skipped, as their list carries their overwrites too.
 */
export function applyAccessFacts(db: Db, f: AccessFacts, seenAt: number): void {
  const named = db.prepare('INSERT INTO guilds (id, name, owner_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id');
  const owner = db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?');
  const overwrites = db.prepare('UPDATE channels SET overwrites = ? WHERE id = ?');
  db.transaction(() => {
    for (const o of f.owners) {
      if (o.name !== null) named.run(o.guildId, o.name, o.ownerId);
      else owner.run(o.ownerId, o.guildId);
    }
    for (const c of f.overwrites) overwrites.run(JSON.stringify(c.overwrites), c.channelId);
    for (const m of f.members) putMember(db, m.guildId, m.userId, { nick: m.nick, roles: m.roles }, seenAt);
  })();
}
