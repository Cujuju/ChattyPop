// Person profile.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../src/core/archive';
import { setSetting, type Db } from '../src/core/db';
import { personProfile } from '../src/core/queries/person';
import { SETTINGS_KEYS } from '@shared/settings';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const THEO = { id: 'u2', username: 'theo', global_name: 'Theo' };
/** Guild ids are snowflakes: privacy mode refuses to mark anything else. */
const HOME = { id: '100000000000000001', name: 'Home' };
const SECRET = { id: '100000000000000002', name: 'Secret' };

describe('person profile', () => {
  let db: Db;
  let archive: Archive;

  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c1', name: 'general' }, { id: 'c2', name: 'lounge' }, { id: 'c3', name: 'hidden', guildId: SECRET.id }], {
      guilds: [HOME, SECRET],
    });
    archive.ingestMessages([
      rawMessage('c1', 1_000, 'hi https://youtube.com/watch?v=a', { author: THEO, member: { nick: 'T-Bone' } }),
      rawMessage('c1', 2_000, 'again https://youtube.com/watch?v=a', { author: THEO }),
      rawMessage('c2', 3_000, 'edited', { author: THEO, edited_timestamp: new Date(3_001).toISOString() }),
      rawMessage('c3', 4_000, 'secret', { author: THEO, member: { nick: 'Shadow' } }),
      rawMessage('c1', 5_000, 'not theo'),
    ], ARRIVAL.sync);
  });

  it('is null for someone the archive never saw', () => {
    expect(personProfile(db, 'nobody')).toBeNull();
  });

  it('counts messages, edits, links and places, busiest channel first', () => {
    const p = personProfile(db, THEO.id)!;
    expect(p.username).toBe('theo');
    expect(p.totals).toEqual({ messages: 4, edited: 1, deleted: 0, links: 1, attachments: 0 });
    expect([p.firstTs, p.lastTs]).toEqual([1_000, 4_000]);
    expect(p.channels.map((c) => [c.channelName, c.count])).toEqual([
      ['general', 2],
      ['hidden', 1],
      ['lounge', 1],
    ]);
    // Each place carries its server, for its icon.
    expect(p.channels.map((c) => [c.channelName, c.guildId, c.guildName])).toContainEqual(['hidden', SECRET.id, SECRET.name]);
    expect(p.nicknames.map((n) => n.nick).sort()).toEqual(['Shadow', 'T-Bone']);
    // Each nickname references a channel in its server for role-colour lookup.
    expect(p.nicknames.map((n) => [n.nick, n.channelId]).sort()).toEqual([['Shadow', 'c3'], ['T-Bone', 'c1']]);
    // One link row, at their latest share of it.
    expect(p.links).toHaveLength(1);
    expect(p.links[0]!.ts).toBe(2_000);
  });

  it('leaves out hidden servers and channels in privacy mode', () => {
    archive.setGuildHideInPrivacy(SECRET.id, true);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const p = personProfile(db, THEO.id)!;
    expect(p.totals.messages).toBe(3);
    expect(p.channels.map((c) => c.channelName)).not.toContain('hidden');
    expect(p.nicknames.map((n) => n.nick)).toEqual(['T-Bone']);
  });

  it("names a nickname's place by a channel privacy mode shows, or none", () => {
    archive.setChannelPolicy('c1', { hideInPrivacy: true });
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(personProfile(db, THEO.id)!.nicknames.find((n) => n.nick === 'T-Bone')!.channelId).toBe('c2');
    archive.setChannelPolicy('c2', { hideInPrivacy: true });
    expect(personProfile(db, THEO.id)!.nicknames.find((n) => n.nick === 'T-Bone')!.channelId).toBeNull();
  });
});
