// Contract tests for privacy.
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_MIN, MS_PER_S } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { setSetting, type Db } from '../src/core/db';
import { directory } from '../src/core/queries/directory';
import { messagePage, messagesByIds } from '../src/core/queries/messages';
import { privacyScope } from '../src/core/queries/privacy';
import { searchMessages } from '../src/core/queries/search';
import { privacyCss } from '../src/main/discord/privacyCss';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const OPEN_GUILD = { id: '100000000000000001', name: 'Open Server' };
const SECRET_GUILD = { id: '100000000000000002', name: 'Secret Server' };
const GENERAL = '200000000000000001';
const MODS = '200000000000000002';
const MODS_THREAD = '300000000000000001';
const SECRET_CHANNEL = '200000000000000003';

let db: Db;
let archive: Archive;
const setMode = (on: boolean): void => setSetting(db, SETTINGS_KEYS.privacyMode, on);
const at = (n: number): number => Date.now() - MS_PER_MIN + n * MS_PER_S;
/** Shared links the archive shows, in first-share order. */
const shownLinks = (): unknown[] => db.prepare('SELECT url FROM archive_links ORDER BY first_ts, id').pluck().all();

beforeEach(() => {
  db = tempDb();
  archive = seedArchive(
    db,
    [
      { id: GENERAL, name: 'general', guildId: OPEN_GUILD.id },
      { id: MODS, name: 'mod-chat', guildId: OPEN_GUILD.id },
      { id: SECRET_CHANNEL, name: 'lobby', guildId: SECRET_GUILD.id },
    ],
    { guilds: [OPEN_GUILD, SECRET_GUILD] },
  );
  archive.upsertThreads([{ id: MODS_THREAD, name: 'side talk', type: 11, parent_id: MODS, last_message_id: null }], 0);
  archive.setChannelPolicy(MODS, { hideInPrivacy: true });
  archive.setGuildHideInPrivacy(SECRET_GUILD.id, true);
});

describe('privacy scope', () => {
  it('hides nothing while privacy mode is off', () => {
    expect(privacyScope(db)).toEqual({ guildIds: [], channelIds: [] });
    const dir = directory(db, 0);
    expect(dir.find((g) => g.id === SECRET_GUILD.id)?.hideInPrivacy).toBe(true);
    expect(dir.flatMap((g) => g.channels).find((c) => c.id === MODS)?.hideInPrivacy).toBe(true);
  });

  it('hides marked channels with their threads, and marked servers with all their channels', () => {
    setMode(true);
    const scope = privacyScope(db);
    expect(scope.guildIds).toEqual([SECRET_GUILD.id]);
    expect(new Set(scope.channelIds)).toEqual(new Set([MODS, MODS_THREAD, SECRET_CHANNEL]));
    const dir = directory(db, 0);
    expect(dir.map((g) => g.id)).not.toContain(SECRET_GUILD.id);
    expect(dir.flatMap((g) => g.channels).map((c) => c.id)).toEqual([GENERAL]);
  });

  it('refuses to mark a server that is not a snowflake (its id is matched inside message text)', () => {
    expect(() => archive.setGuildHideInPrivacy('@me', true)).toThrow();
  });
});

describe('messages in privacy mode', () => {
  beforeEach(() => {
    archive.ingestMessages([
      rawMessage(GENERAL, at(1), 'plain hello'),
      rawMessage(GENERAL, at(2), `see <#${MODS}> hello`),
      rawMessage(GENERAL, at(3), `hello https://discord.com/channels/${SECRET_GUILD.id}/${SECRET_CHANNEL}/1`),
      rawMessage(GENERAL, at(4), 'hello https://example.com/shared'),
      rawMessage(MODS, at(5), 'hello from mods https://example.com/mods'),
    ], ARRIVAL.gateway);
  });

  it('shows everything while off', () => {
    expect(messagePage(db, { channelId: GENERAL, limit: 10 })).toHaveLength(4);
    expect(searchMessages(db, 'hello', 10)).toHaveLength(5);
    expect(shownLinks()).toEqual(['https://example.com/shared', 'https://example.com/mods']); // Discord's own links aren't listed
  });

  it('drops hidden channels and any message naming one by id', () => {
    setMode(true);
    expect(messagePage(db, { channelId: GENERAL, limit: 10 }).map((m) => m.content)).toEqual(['plain hello', 'hello https://example.com/shared']);
    expect(messagePage(db, { channelId: MODS, limit: 10 })).toEqual([]);
    expect(searchMessages(db, 'hello', 10).map((h) => h.channelId)).toEqual([GENERAL, GENERAL]);
    // A link first shared in a hidden channel is gone too.
    expect(shownLinks()).toEqual(['https://example.com/shared']);
  });

  it('looks a message up by id (the alert menu) only while it is shown', () => {
    const [mods] = messagePage(db, { channelId: MODS, limit: 10 });
    expect(messagesByIds(db, [mods!.id]).map((m) => m.content)).toEqual(['hello from mods https://example.com/mods']);
    setMode(true);
    expect(messagesByIds(db, [mods!.id])).toEqual([]);
  });
});

describe('privacy css for the live client', () => {
  it('is empty when nothing is hidden', () => {
    expect(privacyCss({ guildIds: [], channelIds: [] })).toBe('');
  });

  it('hides server rail entries, channel rows and rows linking to hidden ids; non-snowflakes never reach a selector', () => {
    const css = privacyCss({ guildIds: [SECRET_GUILD.id, '"]{}'], channelIds: [MODS] });
    expect(css).toContain(`[data-list-item-id="guildsnav___${SECRET_GUILD.id}"]`);
    expect(css).toContain(`img[src*="/icons/${SECRET_GUILD.id}/"]`);
    expect(css).toContain(`li:has([data-list-item-id="channels___${MODS}"])`);
    expect(css).toContain(`li:has(a[href$="/${MODS}"])`);
    expect(css).toContain(`li:has(a[href*="/${MODS}/"])`);
    expect(css).not.toContain('"]{}');
    expect(css.endsWith('{ display: none !important; }')).toBe(true);
  });
});
