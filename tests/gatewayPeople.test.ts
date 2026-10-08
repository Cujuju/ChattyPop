import { describe, expect, it } from 'vitest';
import { gatewayArchivePayload } from '../src/main/discord/gatewayPeople';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { seedArchive, tempDb } from './helpers';

describe('identity payloads crossing to core', () => {
  it('projects startup and supplemental facts, preserving guild order and removing private and unrelated data', () => {
    const user = { id: 'u', username: 'person', global_name: null, avatar: null, email: 'private-email', phone: 'private-phone' };
    const member = { user_id: 'u', nick: 'Pal', roles: [], unrelated: 'private-member' };
    const source = {
      user, users: [user], session_id: 'private-session', analytics_token: 'private-token',
      read_state: 'unrelated', user_settings: 'unrelated', relationships: ['unrelated'],
      guilds: [{ id: 'g1', channels: ['unrelated'], roles: ['unrelated'], emojis: ['unrelated'] }, { id: 'g2', members: [{ ...member, user }] }],
      merged_members: [[member], [{ user_id: 'u', nick: null }]],
    };
    for (const t of ['READY', 'READY_SUPPLEMENTAL'] as const) {
      const projected = structuredClone(gatewayArchivePayload(t, source));
      expect(projected).toEqual({
        user: { id: 'u', username: 'person', global_name: null, avatar: null },
        users: [{ id: 'u', username: 'person', global_name: null, avatar: null }],
        guilds: [{ id: 'g1', members: [], presences: [] }, { id: 'g2', members: [{ user_id: 'u', nick: 'Pal', roles: [], user: { id: 'u', username: 'person', global_name: null, avatar: null } }], presences: [] }],
        merged_members: [[{ user_id: 'u', nick: 'Pal', roles: [] }], [{ user_id: 'u', nick: null }]],
      });
      expect(JSON.stringify(projected)).not.toMatch(/private-|unrelated/);
      const db = tempDb();
      const archive = seedArchive(db, []);
      applyGatewayEvent(archive, t, projected, { changed: () => undefined, backfillFromMs: () => 0, selfId: () => 'u', dmActivity: () => undefined, autoArchiveSinceMs: () => null, optedIn: () => undefined });
      expect(db.prepare('SELECT guild_id, nick FROM members WHERE user_id = ? ORDER BY guild_id').all('u')).toEqual([{ guild_id: 'g1', nick: 'Pal' }, { guild_id: 'g2', nick: null }]);
    }
  });

  it('projects guilds, nested style fields and presence identities without status or membership inference', () => {
    const person = {
      id: 'u', username: 'person', bot: false,
      primary_guild: { identity_guild_id: 'g', tag: 'TAG', extra: 'unrelated' },
      display_name_styles: { font_id: 1, colors: [1, 2], extra: 'unrelated' },
      avatar_decoration_data: { asset: 'decor', extra: 'unrelated' },
      email: 'private-email',
    };
    const identity = { id: 'u', username: 'person', bot: false, primary_guild: { identity_guild_id: 'g', tag: 'TAG' }, display_name_styles: { font_id: 1, colors: [1, 2] }, avatar_decoration_data: { asset: 'decor' } };
    expect(gatewayArchivePayload('GUILD_CREATE', { id: 'g', channels: ['unrelated'], members: [{ user: person, nick: null, roles: [], communication_disabled_until: null }], presences: [{ user: person, activities: ['unrelated'] }] })).toEqual({ id: 'g', members: [{ user: identity, nick: null, roles: [], communication_disabled_until: null }], presences: [{ user: identity }] });
    expect(gatewayArchivePayload('PRESENCE_UPDATE', { guild_id: 'g', user: person, status: 'online', activities: ['unrelated'] })).toEqual({ user: identity });
    expect(gatewayArchivePayload('USER_UPDATE', person)).toEqual(identity);
    expect(gatewayArchivePayload('PRESENCE_UPDATE', { user: { id: 'u' } })).toEqual({ user: { id: 'u' } });
    expect(gatewayArchivePayload('USER_UPDATE', { id: 'u', global_name: null })).toEqual({ id: 'u', global_name: null });
  });

  it('keeps archive message payloads intact', () => {
    const message = { id: 'm', channel_id: 'c', content: 'archive content', author: { id: 'u', username: 'person' } };
    expect(gatewayArchivePayload('MESSAGE_CREATE', message)).toBe(message);
  });
});
