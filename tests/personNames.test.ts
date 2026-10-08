// Server names use nicknames, role styles, and Nitro fonts. Other contexts use display names and full Nitro styles. Privacy filters hidden contexts; name changes emit updates.
import { beforeEach, describe, expect, it } from 'vitest';
import { DM_CHANNEL_TYPE, type RawRole } from '@shared/discord';
import { SETTINGS_KEYS } from '@shared/settings';
import { setSetting, type Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { personNames } from '../src/core/queries/personNames';
import { watchNameWrites } from '../src/core/nameWrites';
import { applyAccessFacts } from '../src/core/access';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const GENERAL = '200000000000000001';
const LOUNGE = '200000000000000002';
const DM = '200000000000000003';
const SELF = '300000000000000009';
const T0 = Date.UTC(2026, 8, 1);
const MOD = { id: '400000000000000001', name: 'Mod', position: 5, color: 0xf47fff } satisfies RawRole;
const VIP = { id: '400000000000000002', name: 'VIP', position: 3, color: 0x2ecc71, colors: { primary_color: 0x2ecc71, secondary_color: 0x3498db, tertiary_color: null } };
/** Nitro: Vampyre font (10), the Gradient effect (2) in two colours. */
const GRADIENT_STYLE = { font_id: 10, effect_id: 2, colors: [0xfe9242, 0x3498db] };
const alice = { id: '300000000000000001', username: 'alice', global_name: 'Alice', display_name_styles: GRADIENT_STYLE };

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }, { id: LOUNGE, guildId: OTHER_GUILD }], {
    guilds: [{ id: GUILD, name: 'Guild' }, { id: OTHER_GUILD, name: 'Other', features: ['ENHANCED_ROLE_COLORS'] }],
  });
  archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [MOD] });
  archive.applyRoleChange({ kind: 'replace', guildId: OTHER_GUILD, roles: [VIP] });
  archive.ingestMessages([
    rawMessage(GENERAL, T0, 'hi', { author: alice, member: { nick: 'Al', roles: [MOD.id] } }),
    rawMessage(LOUNGE, T0, 'hey', { author: alice, member: { roles: [VIP.id] } }),
  ], ARRIVAL.gateway);
  archive.replacePrivateChannels(SELF, [{ id: DM, type: DM_CHANNEL_TYPE, recipients: [alice] }], false, T0);
});

const nameIn = (channelId: string | null) => personNames(db, [alice.id], channelId)[0];
const FONT = { key: 'sinistre', family: 'Vampyre' };

describe('person names as Discord draws them in a place', () => {
  it('in a server: nickname, role colour, Nitro font, never Nitro colours', () => {
    expect(nameIn(GENERAL)).toEqual({ id: alice.id, name: 'Al', color: MOD.color, gradient: null, font: FONT, effect: null, channelId: GENERAL });
    archive.applyRoleChange({ kind: 'delete', roleId: MOD.id });
    expect(nameIn(GENERAL)).toMatchObject({ color: null, gradient: null, font: FONT, effect: null });
  });

  it('gives one person a different look in each server', () => {
    expect(nameIn(LOUNGE)).toMatchObject({ name: 'Alice', color: VIP.color, gradient: [VIP.color, 0x3498db], channelId: LOUNGE });
    expect(nameIn(GENERAL)).toMatchObject({ name: 'Al', color: MOD.color, gradient: null });
  });

  it('outside a server (a DM, no place): display name and the whole Nitro style', () => {
    const nitro = { name: 'Alice', color: 0xfe9242, gradient: GRADIENT_STYLE.colors, font: FONT, effect: 'gradient' };
    expect(nameIn(DM)).toEqual({ id: alice.id, ...nitro, channelId: DM });
    expect(nameIn(null)).toEqual({ id: alice.id, ...nitro, channelId: null });
  });

  it("draws an effect other than Gradient in its first colour, with the effect's hook", () => {
    archive.ingestMessages([rawMessage(GENERAL, T0 + 1, 'neon', { author: { ...alice, display_name_styles: { font_id: 1, effect_id: 3, colors: [0x691cad] } } })], ARRIVAL.gateway);
    expect(nameIn(null)).toMatchObject({ color: 0x691cad, gradient: null, font: null, effect: 'neon' });
  });

  it('withholds a place privacy mode hides: no nickname, role colour or profile context', () => {
    db.prepare('UPDATE guilds SET hide_in_privacy = 1 WHERE id = ?').run(GUILD);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    expect(nameIn(GENERAL)).toMatchObject({ name: 'Alice', color: 0xfe9242, channelId: null });
    expect(nameIn(LOUNGE)).toMatchObject({ color: VIP.color, channelId: LOUNGE });
  });

  it('leaves out people it does not know', () => {
    expect(personNames(db, ['300000000000000404', alice.id], GENERAL).map((n) => n.id)).toEqual([alice.id]);
    expect(personNames(db, [], GENERAL)).toEqual([]);
  });
});

describe('writes that change a shown name report themselves', () => {
  it('does not write known users for ID-only presence patches', () => {
    const totalChanges = () => db.prepare('SELECT total_changes()').pluck().get();
    const before = totalChanges();
    archive.upsertUsers([{ id: alice.id }, { id: alice.id, global_name: undefined }]);
    expect(totalChanges()).toBe(before);
    expect(nameIn(null)).toMatchObject({ name: 'Alice' });
  });

  it('does not rewrite unchanged full identities or known partial values, but applies explicit clears', () => {
    const totalChanges = () => db.prepare('SELECT total_changes()').pluck().get();
    const before = totalChanges();
    archive.upsertUsers([alice, { id: alice.id, global_name: 'Alice' }]);
    expect(totalChanges()).toBe(before);
    archive.upsertUsers([{ id: alice.id, global_name: null, display_name_styles: null }]);
    expect(totalChanges()).toBeGreaterThan(before as number);
    expect(nameIn(null)).toMatchObject({ name: 'alice', font: null });
    const cleared = totalChanges();
    archive.upsertUsers([{ id: alice.id, global_name: null, display_name_styles: null }]);
    expect(totalChanges()).toBe(cleared);
  });

  it('reports partial identity and avatar changes globally, preserving omitted nickname fields', () => {
    const namesWritten = watchNameWrites(db);
    archive.upsertMembers(GUILD, [{ user: { id: alice.id }, roles: [] }], 'patch');
    expect(nameIn(GENERAL)).toMatchObject({ name: 'Al' });
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
    archive.upsertUsers([{ id: alice.id, avatar: 'new' }]);
    expect(namesWritten()).toEqual({ guildIds: null });
    archive.upsertUsers([{ id: alice.id, avatar: 'new' }]);
    expect(namesWritten()).toBeNull();
    archive.upsertUsers([{ id: alice.id, global_name: 'Alicia' }]);
    expect(nameIn(null)).toMatchObject({ name: 'Alicia' });
    expect(nameIn(LOUNGE)).toMatchObject({ name: 'Alicia' });
    expect(namesWritten()).toEqual({ guildIds: null });
    archive.upsertMembers(GUILD, [{ user: { id: alice.id }, nick: null }], 'patch');
    expect(nameIn(GENERAL)).toMatchObject({ name: 'Alicia' });
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
  });

  it('keeps snapshot semantics and prevents an old message from replacing newer member facts', () => {
    archive.upsertMembers(GUILD, [{ user: { id: alice.id }, nick: 'New', roles: [MOD.id] }], 'patch');
    archive.ingestMessages([rawMessage(GENERAL, T0 + 1, 'old', { author: alice, member: { nick: 'Old', roles: [] } })], ARRIVAL.sync);
    expect(nameIn(GENERAL)).toMatchObject({ name: 'New', color: MOD.color });
    archive.upsertMembers(GUILD, [{ user: { id: alice.id } }]);
    expect(nameIn(GENERAL)).toMatchObject({ name: 'Alice', color: MOD.color });
  });

  it('counts nickname, role, style and server feature changes by server, not unchanged rewrites', () => {
    const namesWritten = watchNameWrites(db);
    expect(namesWritten()).toBeNull();
    archive.upsertMembers(GUILD, [{ user: alice, nick: 'Al', roles: [MOD.id] }]);
    expect(namesWritten()).toBeNull();
    archive.upsertMembers(GUILD, [{ user: alice, nick: 'Ally', roles: [MOD.id] }]);
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
    expect(namesWritten()).toBeNull();
    archive.applyRoleChange({ kind: 'put', guildId: GUILD, role: { ...MOD, color: 0x3498db } });
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
    archive.upsertGuilds([{ id: GUILD, name: 'Guild', features: ['ENHANCED_ROLE_COLORS'] }]);
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
    // A user's own name shows in every server.
    archive.ingestMessages([rawMessage(GENERAL, T0 + 2, 'renamed', { author: { ...alice, global_name: 'Alicia' } })], ARRIVAL.gateway);
    expect(namesWritten()).toEqual({ guildIds: null });
    archive.ingestMessages([rawMessage(GENERAL, T0 + 3, 'same', { author: { ...alice, global_name: 'Alicia' } })], ARRIVAL.gateway);
    expect(namesWritten()).toBeNull();
  });

  it("counts a change to who can see a channel (a server's owner, a channel's overwrites), not the same facts again", () => {
    const namesWritten = watchNameWrites(db);
    const facts = { owners: [{ guildId: GUILD, name: null, ownerId: SELF }], overwrites: [{ channelId: GENERAL, overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }] }], members: [] };
    applyAccessFacts(db, facts, T0);
    expect(namesWritten()).toEqual({ guildIds: [GUILD] });
    applyAccessFacts(db, facts, T0 + 1);
    expect(namesWritten()).toBeNull();
  });
});
