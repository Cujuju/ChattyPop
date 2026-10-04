import { describe, expect, it } from 'vitest';
import type { MentionCandidate } from '@shared/contract';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, type RawRole } from '@shared/discord';
import { PERMISSIONS, PRIVATE_THREAD_TYPE } from '@shared/permissions';
import { applyAccessFacts } from '../src/core/access';
import type { Db } from '../src/core/db';
import { forgetMentionPools, mentionCandidates } from '../src/core/queries/mentions';
import { watchNameWrites } from '../src/core/nameWrites';
import { MS_PER_HOUR } from '@shared/units';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const SELF = 'me';
const OWNER = 'own';
const perms = (...bits: bigint[]): string => bits.reduce((a, b) => a | b, 0n).toString();
const ROLES: RawRole[] = [
  // The server's own @everyone role: everyone sees channels unless an overwrite says otherwise.
  { id: 'g1', name: '@everyone', position: 0, mentionable: true, permissions: perms(PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.SEND_MESSAGES) },
  { id: 'rMods', name: 'Mods', position: 5, color: 0xf47fff, mentionable: true, permissions: '0' },
  { id: 'rAdmin', name: 'Admin', position: 8, mentionable: false, permissions: perms(PERMISSIONS.ADMINISTRATOR) },
  { id: 'rPing', name: 'Pingers', position: 1, mentionable: false, permissions: perms(PERMISSIONS.MENTION_EVERYONE) },
  { id: 'rTonkers', name: 'Tonkers', position: 2, mentionable: true, permissions: '0' },
  { id: 'rBig', name: 'Big Ton', position: 7, mentionable: true, permissions: '0' },
  { id: 'rTonnage', name: 'Tonnage', position: 9, mentionable: false, permissions: '0' },
] as RawRole[];

const member = (id: string, username: string, roles: string[], o: { global_name?: string; nick?: string } = {}) => ({
  user: { id, username, global_name: o.global_name ?? null },
  nick: o.nick ?? null,
  roles,
});
const author = (id: string, username: string, global_name: string | null = null) => ({ author: { id, username, global_name } });

function seed(selfRoles: string[] = []): Db {
  const db = tempDb();
  const archive = seedArchive(db, [{ id: 'c1' }, { id: 'c2' }]);
  archive.upsertChannels('g1', [
    { id: 't1', name: 't1', type: 11, parent_id: 'c2' },
    { id: 't2', name: 't2', type: PRIVATE_THREAD_TYPE, parent_id: 'c2' },
  ]);
  archive.applyRoleChange({ kind: 'replace', guildId: 'g1', roles: ROLES });
  archive.upsertMembers('g1', [
    member('1', 'tony_t', [], { global_name: 'Tony' }),
    member('2', 'stat', ['rMods'], { nick: 'Statler' }),
    member('3', 'ton', []),
    member('4', 'mrt', [], { global_name: 'Mr Tonka' }),
    member('5', 'tonymember', []),
    member('6', 'tonyadmin', ['rAdmin']),
    member('7', 'tonya', []),
    member('11', 'zed', [], { global_name: 'Éva' }),
    member(OWNER, 'boss', []),
    member(SELF, 'myself', selfRoles),
  ] as never);
  archive.ingestMessages(
    [
      rawMessage('c1', 1, 'a', author('1', 'tony_t', 'Tony')),
      // Fetched history carries no member: posting here is what shows they can see it.
      rawMessage('c1', 2, 'b', author('9', 'tonyhist')),
      rawMessage('c1', 3, 'c', author('3', 'ton')),
      rawMessage('c1', 4, 'd', { ...author('8', 'tonywebhook'), webhook_id: 'w1' } as never),
    ],
    ARRIVAL.gateway,
  );
  archive.upsertPrivateChannel(SELF, { id: 'dm1', type: DM_CHANNEL_TYPE, recipients: [{ id: '10', username: 'tonydm' }] }, true);
  applyAccessFacts(
    db,
    {
      owners: [{ guildId: 'g1', name: null, ownerId: OWNER }],
      // c2: hidden from @everyone; Mods and member 5 may see it.
      overwrites: [
        {
          channelId: 'c2',
          overwrites: [
            { id: 'g1', type: 0, allow: '0', deny: perms(PERMISSIONS.VIEW_CHANNEL) },
            { id: 'rMods', type: 0, allow: perms(PERMISSIONS.VIEW_CHANNEL), deny: '0' },
            { id: '5', type: 1, allow: perms(PERMISSIONS.VIEW_CHANNEL), deny: '0' },
          ],
        },
      ],
      members: [],
    },
    Date.now(),
  );
  return db;
}

/** A person by username, a role as `&name`, @everyone and @here as typed. */
const label = (c: MentionCandidate): string | null => (c.kind === 'user' ? c.username : c.kind === 'role' ? `&${c.name}` : `@${c.kind}`);
const labels = (db: Db, channelId: string, query: string, limit = 10): (string | null)[] => mentionCandidates(db, SELF, channelId, query, limit).map(label);

describe('what @ offers in a channel, as Discord does', () => {
  it('lists who can see it: names starting with the text, posters here last first, then loose matches, then roles', () => {
    const db = seed();
    // The webhook posted here but can't be mentioned; Tonnage isn't mentionable.
    expect(labels(db, 'c1', 'ton')).toEqual(['ton', 'tonyhist', 'tony_t', 'tonya', 'tonyadmin', 'tonymember', 'mrt', '&Tonkers', '&Big Ton']);
    expect(labels(db, 'c1', 'TON', 2)).toEqual(['ton', 'tonyhist']);
    expect(mentionCandidates(db, SELF, 'c1', 'statl', 10)).toMatchObject([{ kind: 'user', name: 'Statler' }]);
  });

  it("follows the channel's overwrites, Administrator and the owner; a thread, public or private, follows its parent", () => {
    const db = seed();
    expect(labels(db, 'c2', 'ton')).toEqual(['tonyadmin', 'tonymember', '&Tonkers', '&Big Ton']);
    expect(labels(db, 'c2', 'sta')).toEqual(['stat']);
    // Loose matches count, as in Discord: b…o in Big Ton.
    expect(labels(db, 'c2', 'bo')).toEqual(['boss', '&Big Ton']);
    expect(labels(db, 't1', 'tony')).toEqual(['tonyadmin', 'tonymember']);
    // A private thread offers the same people: mentioning one adds them to it.
    expect(labels(db, 't2', 'tony')).toEqual(['tonyadmin', 'tonymember']);
  });

  it('lists who posted last for a bare @, roles filling the rest; ten in all', () => {
    const db = seed();
    expect(labels(db, 'c1', '')).toEqual(['ton', 'tonyhist', 'tony_t', '&Big Ton', '&Mods', '&Tonkers']);
    expect(labels(db, 'c1', '', 4)).toEqual(['ton', 'tonyhist', 'tony_t', '&Big Ton']);
  });

  it('offers @everyone and @here, and every role, only when the owner may mention everyone', () => {
    expect(labels(seed(), 'c1', 'every')).toEqual([]);
    const db = seed(['rPing']);
    expect(labels(db, 'c1', 'every')).toEqual(['@everyone']);
    expect(labels(db, 'c1', 'ere')).toEqual(['@everyone', '@here']);
    expect(labels(db, 'c1', 'tonn')).toEqual(['tonyadmin', '&Tonnage']);
  });

  it('matches names without case, accents or width', () => {
    const db = seed();
    expect(labels(db, 'c1', 'eva')).toEqual(['zed']);
    expect(labels(db, 'c1', 'ＥＶＡ')).toEqual(['zed']);
  });

  it("lists a DM's own people only, the owner included, as Discord does", () => {
    expect(labels(seed(['rPing']), 'dm1', '')).toEqual(['myself', 'tonydm']);
  });

  it("lists a group DM's recipients and the owner, posted or not", () => {
    const db = seed();
    const archive = seedArchive(db, []);
    archive.upsertPrivateChannel(SELF, { id: 'gdm', type: GROUP_DM_CHANNEL_TYPE, name: 'crew', recipients: [{ id: '12', username: 'quietone' }, { id: '13', username: 'quieter' }] }, true);
    expect(labels(db, 'gdm', 'qui')).toEqual(['quieter', 'quietone']);
    expect(labels(db, 'gdm', 'mys')).toEqual(['myself']);
  });

  it('drops people who left the server, until they come back', () => {
    const db = seed();
    const archive = seedArchive(db, []);
    archive.markMemberLeft('g1', '3');
    expect(labels(db, 'c1', 'ton', 1)).toEqual(['tonyhist']);
    archive.upsertMembers('g1', [member('3', 'ton', [])] as never);
    expect(labels(db, 'c1', 'ton', 1)).toEqual(['ton']);
  });

  it('offers no @everyone, @here or unmentionable role where the owner may not send, or while timed out', () => {
    const sendDenied = seed(['rPing']);
    const deny = { id: 'g1', type: 0, allow: '0', deny: perms(PERMISSIONS.SEND_MESSAGES) };
    applyAccessFacts(sendDenied, { owners: [], overwrites: [{ channelId: 'c1', overwrites: [deny] }], members: [] }, Date.now());
    expect(labels(sendDenied, 'c1', 'every')).toEqual([]);
    expect(labels(sendDenied, 'c1', 'tonn')).toEqual(['tonyadmin']);

    const timedOut = seed(['rPing']);
    const timeout = (until: number) => ({ owners: [], overwrites: [], members: [{ guildId: 'g1', userId: SELF, nick: null, roles: ['rPing'], communicationDisabledUntil: new Date(until).toISOString() }] });
    applyAccessFacts(timedOut, timeout(Date.now() + MS_PER_HOUR), Date.now());
    expect(labels(timedOut, 'c1', 'every')).toEqual([]);
    applyAccessFacts(timedOut, timeout(Date.now() - MS_PER_HOUR), Date.now() + 1);
    expect(labels(timedOut, 'c1', 'every')).toEqual(['@everyone']);
  });

  it("keeps a channel's people between keystrokes, read again once its messages or any name or access data change", () => {
    const db = seed();
    watchNameWrites(db);
    const archive = seedArchive(db, []);
    expect(labels(db, 'c1', '', 2)).toEqual(['ton', 'tonyhist']);
    // A new message is seen once core reports the channel changed.
    archive.ingestMessages([rawMessage('c1', 5, 'e', author('7', 'tonya'))], ARRIVAL.gateway);
    expect(labels(db, 'c1', '', 2)).toEqual(['ton', 'tonyhist']);
    forgetMentionPools('c1');
    expect(labels(db, 'c1', '', 2)).toEqual(['tonya', 'ton']);
    // Names and access report themselves.
    archive.upsertMembers('g1', [member('12', 'tonynew', [])] as never);
    expect(labels(db, 'c1', 'tonynew')).toEqual(['tonynew']);
    const hide = { id: '12', type: 1, allow: '0', deny: perms(PERMISSIONS.VIEW_CHANNEL) };
    applyAccessFacts(db, { owners: [], overwrites: [{ channelId: 'c1', overwrites: [hide] }], members: [] }, Date.now());
    expect(labels(db, 'c1', 'tonynew')).toEqual([]);
  });

  it("reads a channel's posters from an index, not its every message", () => {
    const db = seed();
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT author_id, MAX(ts) FROM messages WHERE channel_id = ? GROUP BY author_id').all('c1') as { detail: string }[];
    expect(plan.map((r) => r.detail).join(' ')).toContain('COVERING INDEX messages_channel_author');
  });
});
