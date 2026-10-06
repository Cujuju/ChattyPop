// Author styles use current server roles: highest coloured role, highest role icon, server tag, and APP badge.
import { beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_MIN } from '@shared/units';
import { VERIFIED_BOT_FLAG, type RawRole } from '@shared/discord';
import type { Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { messagePage } from '../src/core/queries/messages';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const T0 = Date.UTC(2026, 8, 1);
const deps = { changed: () => undefined, backfillFromMs: () => 0, selfId: () => null, dmActivity: () => undefined, autoArchiveSinceMs: () => null, optedIn: () => undefined };
const alice = { id: '300000000000000001', username: 'alice', global_name: 'Alice' };

const MOD = { id: '400000000000000001', name: 'Mod', position: 5, color: 0xf47fff, icon: 'a'.repeat(32) } satisfies RawRole;
const BOOSTER = { id: '400000000000000002', name: 'Booster', position: 9, color: 0, unicode_emoji: '🚀' } satisfies RawRole;
const MEMBER = { id: '400000000000000003', name: 'Member', position: 1, color: 0x2ecc71 } satisfies RawRole;

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: GENERAL }], { guilds: [{ id: GUILD, name: 'Guild' }] });
  archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [MOD, BOOSTER, MEMBER] });
});

const author = () => messagePage(db, { channelId: GENERAL, limit: 10 }).at(-1)!.author;

describe("author names as Discord draws them", () => {
  it('takes the colour of the highest role with one and the icon of the highest role with one', () => {
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice, member: { roles: [MEMBER.id, BOOSTER.id, MOD.id] } })], ARRIVAL.gateway);
    expect(author()).toMatchObject({ color: MOD.color, roleIcon: { roleId: BOOSTER.id, name: 'Booster', icon: null, emoji: '🚀' }, tag: null, app: null });
  });

  it('follows role and member changes, and keeps roles a payload without them says nothing about', () => {
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice, member: { roles: [MOD.id] } })], ARRIVAL.gateway);
    applyGatewayEvent(archive, 'GUILD_ROLE_UPDATE', { guild_id: GUILD, role: { ...MOD, color: 0x3498db } }, deps);
    expect(author().color).toBe(0x3498db);
    applyGatewayEvent(archive, 'GUILD_MEMBER_UPDATE', { guild_id: GUILD, user: alice, nick: 'Al' }, deps);
    expect(author()).toMatchObject({ name: 'Al', color: 0x3498db });
    applyGatewayEvent(archive, 'GUILD_ROLE_DELETE', { guild_id: GUILD, role_id: MOD.id }, deps);
    expect(author()).toMatchObject({ color: null, roleIcon: null });
    // A new list without a role deletes it.
    archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [MEMBER] });
    applyGatewayEvent(archive, 'GUILD_MEMBER_UPDATE', { guild_id: GUILD, user: alice, roles: [BOOSTER.id, MEMBER.id] }, deps);
    expect(author()).toMatchObject({ color: MEMBER.color, roleIcon: null });
  });

  it('draws a gradient only where the server has Enhanced Role Styles; three colours are holographic', () => {
    const GRADIENT = { ...MOD, colors: { primary_color: MOD.color, secondary_color: 0x3498db, tertiary_color: null } };
    archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [GRADIENT, BOOSTER, MEMBER] });
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: alice, member: { roles: [MOD.id] } })], ARRIVAL.gateway);
    expect(author()).toMatchObject({ color: MOD.color, gradient: null });
    archive.upsertGuilds([{ id: GUILD, name: 'Guild', features: ['ROLE_ICONS', 'ENHANCED_ROLE_COLORS'] }]);
    expect(author().gradient).toEqual([MOD.color, 0x3498db]);
    archive.applyRoleChange({ kind: 'put', guildId: GUILD, role: { ...GRADIENT, colors: { ...GRADIENT.colors, tertiary_color: 0xffd1a0 } } });
    expect(author().gradient).toEqual([MOD.color, 0x3498db, 0xffd1a0]);
    // A server list without features says nothing about them.
    archive.upsertGuilds([{ id: GUILD, name: 'Guild' }]);
    expect(author().gradient).toHaveLength(3);
  });

  it("carries the user's name font (Discord's font enum; retired ones draw in the default face) and avatar decoration", () => {
    const styled = { ...alice, display_name_styles: { font_id: 10, effect_id: 7, colors: [0xfe9242] }, avatar_decoration_data: { asset: 'a_' + 'c'.repeat(32) } };
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: styled })], ARRIVAL.gateway);
    expect(author()).toMatchObject({ font: { key: 'sinistre', family: 'Vampyre' }, decoration: 'a_' + 'c'.repeat(32) });
    archive.ingestMessages([rawMessage(GENERAL, T0 + MS_PER_MIN, 'again', { author: alice })], ARRIVAL.gateway);
    expect(author().font?.key).toBe('sinistre');
    archive.ingestMessages([rawMessage(GENERAL, T0 + 2 * MS_PER_MIN, 'retired', { author: { ...styled, display_name_styles: { font_id: 1 }, avatar_decoration_data: null } })], ARRIVAL.gateway);
    expect(author()).toMatchObject({ font: null, decoration: null });
  });

  it("colours a reply's name with the replied-to author's role colour", () => {
    const first = rawMessage(GENERAL, T0, 'question', { author: alice, member: { roles: [MOD.id] } });
    archive.ingestMessages([first], ARRIVAL.gateway);
    const bob = { id: '300000000000000002', username: 'bob' };
    archive.ingestMessages([rawMessage(GENERAL, T0 + MS_PER_MIN, 'answer', { author: bob, type: 19, message_reference: { message_id: first.id } })], ARRIVAL.gateway);
    expect(messagePage(db, { channelId: GENERAL, limit: 10 }).at(-1)!.reply).toMatchObject({ authorName: 'Alice', authorColor: MOD.color });
  });

  it('shows the server tag the user turned on, kept when a payload says nothing about it; marks apps', () => {
    const tagged = { ...alice, primary_guild: { identity_guild_id: GUILD, identity_enabled: true, tag: 'UW', badge: 'b'.repeat(32) } };
    archive.ingestMessages([rawMessage(GENERAL, T0, 'hi', { author: tagged })], ARRIVAL.gateway);
    expect(author().tag).toEqual({ guildId: GUILD, text: 'UW', badge: 'b'.repeat(32) });
    archive.ingestMessages([rawMessage(GENERAL, T0 + MS_PER_MIN, 'again', { author: alice })], ARRIVAL.gateway);
    expect(author().tag?.text).toBe('UW');
    archive.ingestMessages([rawMessage(GENERAL, T0 + 2 * MS_PER_MIN, 'off', { author: { ...tagged, primary_guild: { ...tagged.primary_guild, identity_enabled: false } } })], ARRIVAL.gateway);
    expect(author().tag).toBeNull();
    archive.ingestMessages([rawMessage(GENERAL, T0 + 3 * MS_PER_MIN, 'beep', { author: { id: '300000000000000009', username: 'bot', bot: true } })], ARRIVAL.gateway);
    expect(author()).toMatchObject({ app: { verified: false }, color: null });
    const verified = { id: '300000000000000010', username: 'verified', bot: true, public_flags: VERIFIED_BOT_FLAG };
    archive.ingestMessages([rawMessage(GENERAL, T0 + 4 * MS_PER_MIN, 'beep', { author: verified })], ARRIVAL.gateway);
    expect(author().app).toEqual({ verified: true });
  });
});
