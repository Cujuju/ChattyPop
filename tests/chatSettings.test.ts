// Discord's Chat settings: the contract's normalizers and routing, the settings proto's verified fields read and written
// as the web client writes them, the gateway's updates, emoticon conversion and what the display settings decide.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEVICE_CHAT_RECORD,
  DEFAULT_SYNCED_CHAT_SETTINGS,
  embedMediaReplacesLink,
  normalizeDeviceChatRecord,
  normalizeDiscordChatSettings,
  normalizeSyncedChatChange,
  normalizeSyncedChatSettings,
  routeChatChange,
  shownChatSettings,
  shownImageDescription,
  spoilersUncovered,
  uploadShownInline,
  withSyncAcrossClients,
  type SyncedChatSettings,
} from '@shared/chatSettings';
import { convertEmoticons } from '@shared/emoticons';
import { AccountChatSettings, chatSettingsFromProto, chatSettingsPatch } from '../src/main/discord/chatSettings';
import { fields } from '../src/main/discord/settingsProto';
import type { DiscordClient } from '../src/main/discord/client';
import type { GatewayTap } from '../src/main/discord/gatewayTap';

/** Hand-encoded fields, so the tests pin the verified numbers rather than the encoder: tag = no << 3 | wire. */
const LEN = 2;
const tag = (no: number, wire: number): number[] => {
  const v = (no << 3) | wire;
  return v < 0x80 ? [v] : [(v & 0x7f) | 0x80, v >> 7];
};
const msg = (no: number, body: number[]): number[] => [...tag(no, LEN), body.length, ...body];
const on = (no: number): number[] => msg(no, [0x08, 0x01]);
const off = (no: number): number[] => msg(no, []);
const text = (no: number, s: string): number[] => msg(no, msg(1, [...Buffer.from(s, 'utf8')]));
/** PreloadedUserSettings with text_and_images (6) holding `body`, beside an unrelated top-level field (versions, 1). */
const VERSIONS = msg(1, [0x08, 0x14]);
const settings = (body: number[]): Buffer => Buffer.from([...VERSIONS, ...msg(6, body)]);
/** A text_and_images field ChattyPop doesn't know: diversity_surrogate (1), kept byte for byte on write. */
const SURROGATE = text(1, '🏾');

describe('the chat settings contract', () => {
  it('normalizes to Discord’s defaults, keeping only valid values', () => {
    expect(normalizeSyncedChatSettings(null)).toEqual(DEFAULT_SYNCED_CHAT_SETTINGS);
    expect(normalizeSyncedChatSettings({ renderEmbeds: false, spoilers: 'bogus', stickersInAutocomplete: 'yes' })).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderEmbeds: false });
    expect(normalizeDiscordChatSettings({ syncAcrossClients: false }).syncAcrossClients).toBe(false);
    // Verified: an account that never set it shows stickers in autocomplete off.
    expect(DEFAULT_SYNCED_CHAT_SETTINGS.stickersInAutocomplete).toBe(false);
  });

  it('a change keeps only its valid fields', () => {
    expect(normalizeSyncedChatChange({ renderReactions: false, spoilers: 'always', convertEmoticons: 1, other: true })).toEqual({ renderReactions: false, spoilers: 'always' });
    expect(normalizeSyncedChatChange('x')).toEqual({});
  });

  it('a device record normalizes each part', () => {
    const r = normalizeDeviceChatRecord({ device: { videoQuality: 'best', doubleTapEmoji: { id: null, name: '🔥', animated: false } }, syncAcrossClients: false, unsynced: { renderEmbeds: false } });
    expect(r.device.videoQuality).toBe('best');
    expect(r.device.doubleTapEmoji.name).toBe('🔥');
    expect(r.syncAcrossClients).toBe(false);
    expect(r.unsynced.renderEmbeds).toBe(false);
    expect(normalizeDeviceChatRecord(undefined)).toEqual(DEFAULT_DEVICE_CHAT_RECORD);
  });

  it('a syncing device shows the account’s settings and writes changes there; one not syncing keeps its own', () => {
    const account: SyncedChatSettings = { ...DEFAULT_SYNCED_CHAT_SETTINGS, renderReactions: false };
    expect(shownChatSettings(account, DEFAULT_DEVICE_CHAT_RECORD)).toEqual({ ...account, syncAcrossClients: true });
    expect(routeChatChange(DEFAULT_DEVICE_CHAT_RECORD, { renderEmbeds: false })).toEqual({ account: { renderEmbeds: false } });

    // Turning sync off keeps showing what the account showed; later account changes don't reach this device.
    const local = withSyncAcrossClients(DEFAULT_DEVICE_CHAT_RECORD, false, account);
    expect(shownChatSettings({ ...account, renderEmbeds: false }, local)).toEqual({ ...account, syncAcrossClients: false });
    const routed = routeChatChange(local, { spoilers: 'always' });
    expect('record' in routed && routed.record.unsynced.spoilers).toBe('always');
    // On again: the account's settings show.
    expect(shownChatSettings(account, withSyncAcrossClients(local, true, account)).renderReactions).toBe(false);
  });

  it('spoilers show uncovered always, or where the owner moderates in that mode', () => {
    expect(spoilersUncovered('click', true)).toBe(false);
    expect(spoilersUncovered('always', false)).toBe(true);
    expect(spoilersUncovered('moderated', true)).toBe(true);
    expect(spoilersUncovered('moderated', false)).toBe(false);
  });

  it('the display settings decide inline uploads, image descriptions and a link’s text', () => {
    const offs: SyncedChatSettings = { ...DEFAULT_SYNCED_CHAT_SETTINGS, inlineAttachmentMedia: false, inlineLinkMedia: false };
    expect(uploadShownInline('image', DEFAULT_SYNCED_CHAT_SETTINGS)).toBe(true);
    expect(uploadShownInline('video', offs)).toBe(false);
    // Audio keeps its player.
    expect(uploadShownInline('audio', offs)).toBe(true);
    expect(shownImageDescription('image', 'a cat', DEFAULT_SYNCED_CHAT_SETTINGS)).toBeNull();
    expect(shownImageDescription('image', 'a cat', { ...DEFAULT_SYNCED_CHAT_SETTINGS, imageDescriptions: true })).toBe('a cat');
    expect(shownImageDescription('video', 'a cat', { ...DEFAULT_SYNCED_CHAT_SETTINGS, imageDescriptions: true })).toBeNull();
    expect(embedMediaReplacesLink(DEFAULT_SYNCED_CHAT_SETTINGS)).toBe(true);
    expect(embedMediaReplacesLink(offs)).toBe(false);
    expect(embedMediaReplacesLink({ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderEmbeds: false })).toBe(false);
  });
});

describe('the settings proto (fields verified against the web client’s PATCHes)', () => {
  it('reads each verified field; absent ones keep Discord’s defaults', () => {
    const read = chatSettingsFromProto(settings([...SURROGATE, ...text(4, 'IF_MODERATOR'), ...on(7), ...off(9), ...off(10), ...off(12), ...off(13), ...off(21), ...on(28)]));
    expect(read).toEqual({
      spoilers: 'moderated',
      imageDescriptions: true,
      inlineAttachmentMedia: false,
      inlineLinkMedia: false,
      renderEmbeds: false,
      renderReactions: false,
      convertEmoticons: false,
      stickersInAutocomplete: true,
    });
    expect(chatSettingsFromProto(settings([...text(4, 'ALWAYS')]))).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, spoilers: 'always' });
    expect(chatSettingsFromProto(settings([]))).toEqual(DEFAULT_SYNCED_CHAT_SETTINGS);
  });

  it('a proto without text_and_images carries no chat settings', () => {
    expect(chatSettingsFromProto(Buffer.from(VERSIONS))).toBeNull();
  });

  it('a PATCH carries only text_and_images, whole: changed fields rewritten, every other field kept', () => {
    const current = settings([...SURROGATE, ...on(13), ...on(9), ...text(4, 'ON_CLICK')]);
    const patch = chatSettingsPatch(current, { renderReactions: false, spoilers: 'always', stickersInAutocomplete: true });
    const top = fields(patch);
    expect(top.map((f) => f.no)).toEqual([6]);
    const sub = fields('bytes' in top[0]! ? top[0].bytes : Buffer.alloc(0));
    // Kept as they were, in order, then the rewritten ones.
    expect(Buffer.concat(sub.slice(0, 2).map((f) => f.raw))).toEqual(Buffer.from([...SURROGATE, ...on(9)]));
    expect(sub.filter((f) => f.no === 13).map((f) => [...f.raw])).toEqual([off(13)]);
    expect(sub.filter((f) => f.no === 28).map((f) => [...f.raw])).toEqual([on(28)]);
    expect(sub.filter((f) => f.no === 4).map((f) => [...f.raw])).toEqual([text(4, 'ALWAYS')]);
    expect(chatSettingsFromProto(patch)).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, inlineAttachmentMedia: true, renderReactions: false, spoilers: 'always', stickersInAutocomplete: true });
  });

  it('writes over the settings read just before, as {settings: base64}, and holds Discord’s answer', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const answer = settings([...off(12)]);
    const owner = {
      get: async () => ({ settings: settings([...SURROGATE]).toString('base64') }),
      patch: async (path: string, body: unknown) => {
        sent.push({ path, body });
        return { settings: answer.toString('base64') };
      },
    } as unknown as DiscordClient;
    const put: SyncedChatSettings[] = [];
    await new AccountChatSettings(new EventEmitter() as unknown as GatewayTap, owner, (s) => put.push(s), () => undefined).write({ renderEmbeds: false });
    expect(put).toEqual([{ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderEmbeds: false }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe('users/@me/settings-proto/1');
    expect(Object.keys(sent[0]!.body as object)).toEqual(['settings']);
    const body = Buffer.from((sent[0]!.body as { settings: string }).settings, 'base64');
    expect([...body]).toEqual(msg(6, [...SURROGATE, ...off(12)]));
  });

  it('follows READY and updates: a partial update without text_and_images changes nothing', () => {
    const tap = new EventEmitter();
    const put: SyncedChatSettings[] = [];
    new AccountChatSettings(tap as unknown as GatewayTap, {} as DiscordClient, (s) => put.push(s), () => undefined);
    const dispatch = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, d });
    dispatch('READY', { user_settings_proto: Buffer.from(VERSIONS).toString('base64') });
    expect(put).toEqual([DEFAULT_SYNCED_CHAT_SETTINGS]);
    dispatch('USER_SETTINGS_PROTO_UPDATE', { settings: { type: 1, proto: Buffer.from(VERSIONS).toString('base64') }, partial: true });
    expect(put).toHaveLength(1);
    dispatch('USER_SETTINGS_PROTO_UPDATE', { settings: { type: 1, proto: settings([...off(13)]).toString('base64') }, partial: true });
    expect(put.at(-1)).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderReactions: false });
    // Another settings type (frecency) is not these settings.
    dispatch('USER_SETTINGS_PROTO_UPDATE', { settings: { type: 2, proto: settings([...on(13)]).toString('base64') }, partial: true });
    expect(put).toHaveLength(2);
  });

  it('applies a partial update over the last known settings, not over the defaults', () => {
    // Regression: a partial carrying one field reset every other chat setting to Discord's default.
    const tap = new EventEmitter();
    const put: SyncedChatSettings[] = [];
    new AccountChatSettings(tap as unknown as GatewayTap, {} as DiscordClient, (s) => put.push(s), () => undefined);
    const dispatch = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, d });
    dispatch('READY', { user_settings_proto: settings([...off(12), ...text(4, 'ALWAYS')]).toString('base64') });
    dispatch('USER_SETTINGS_PROTO_UPDATE', { settings: { type: 1, proto: settings([...off(13)]).toString('base64') }, partial: true });
    expect(put.at(-1)).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderEmbeds: false, spoilers: 'always', renderReactions: false });
    // A whole proto starts again from the defaults.
    dispatch('USER_SETTINGS_PROTO_UPDATE', { settings: { type: 1, proto: settings([...off(13)]).toString('base64') }, partial: false });
    expect(put.at(-1)).toEqual({ ...DEFAULT_SYNCED_CHAT_SETTINGS, renderReactions: false });
  });
});

/** Discord's side of the settings proto: GET answers the stored proto; PATCH replaces text_and_images with the body's, held until answered. */
function account(start: Buffer) {
  let stored = start;
  const held: (() => void)[] = [];
  const owner = {
    get: async () => {
      await Promise.resolve();
      return { settings: stored.toString('base64') };
    },
    patch: async (_path: string, body: { settings: string }) => {
      stored = Buffer.from([...VERSIONS, ...Buffer.from(body.settings, 'base64')]);
      const answer = stored;
      await new Promise<void>((release) => held.push(release));
      return { settings: answer.toString('base64') };
    },
  } as unknown as DiscordClient;
  return { owner, held, stored: () => chatSettingsFromProto(stored) };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

describe('the account’s chat settings, written and followed', () => {
  it('runs overlapping writes one after another, so neither undoes the other', async () => {
    // Regression: GET A, GET B, PATCH A, PATCH B — B's whole text_and_images put embeds back off.
    const discord = account(settings([...off(12), ...off(13)]));
    const sync = new AccountChatSettings(new EventEmitter() as unknown as GatewayTap, discord.owner, () => undefined, () => undefined);
    const writes = [sync.write({ renderEmbeds: true }), sync.write({ renderReactions: true })];
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(discord.held).toHaveLength(i + 1));
      discord.held[i]!();
    }
    await Promise.all(writes);
    expect(discord.stored()).toMatchObject({ renderEmbeds: true, renderReactions: true });
  });

  it('keeps a newer gateway update over a write answer that arrives after it', async () => {
    // Regression: a delayed PATCH answer put reactions back on after the gateway had turned them off.
    const discord = account(settings([]));
    const tap = new EventEmitter();
    const put: SyncedChatSettings[] = [];
    const sync = new AccountChatSettings(tap as unknown as GatewayTap, discord.owner, (s) => put.push(s), () => undefined);
    const update = (body: number[]): boolean => tap.emit('dispatch', { t: 'USER_SETTINGS_PROTO_UPDATE', d: { settings: { type: 1, proto: settings(body).toString('base64') }, partial: true } });
    const write = sync.write({ renderEmbeds: false });
    await vi.waitFor(() => expect(discord.held).toHaveLength(1));
    update([...off(12)]); // the write's echo
    update([...off(12), ...off(13)]); // another client, later
    discord.held[0]!();
    await write;
    expect(put.at(-1)).toMatchObject({ renderEmbeds: false, renderReactions: false });
  });

  it('keeps another client’s later change to the same setting once the write’s echo came', async () => {
    const discord = account(settings([]));
    const tap = new EventEmitter();
    const put: SyncedChatSettings[] = [];
    const sync = new AccountChatSettings(tap as unknown as GatewayTap, discord.owner, (s) => put.push(s), () => undefined);
    const update = (body: number[]): boolean => tap.emit('dispatch', { t: 'USER_SETTINGS_PROTO_UPDATE', d: { settings: { type: 1, proto: settings(body).toString('base64') }, partial: true } });
    const write = sync.write({ renderEmbeds: false });
    await vi.waitFor(() => expect(discord.held).toHaveLength(1));
    update([...off(12)]); // the write's echo
    update([...on(12)]); // another client turns embeds back on
    discord.held[0]!();
    await write;
    expect(put.at(-1)).toMatchObject({ renderEmbeds: true });
  });

  it('takes the write’s answer over a gateway update that predates it', async () => {
    const discord = account(settings([]));
    const tap = new EventEmitter();
    const put: SyncedChatSettings[] = [];
    const sync = new AccountChatSettings(tap as unknown as GatewayTap, discord.owner, (s) => put.push(s), () => undefined);
    const write = sync.write({ renderEmbeds: false });
    await vi.waitFor(() => expect(discord.held).toHaveLength(1));
    // An older change from another client, arriving before the write's echo.
    tap.emit('dispatch', { t: 'USER_SETTINGS_PROTO_UPDATE', d: { settings: { type: 1, proto: settings([...on(12)]).toString('base64') }, partial: true } });
    discord.held[0]!();
    await write;
    await flush();
    expect(put.at(-1)).toMatchObject({ renderEmbeds: false });
  });
});

describe('emoticon conversion', () => {
  it('turns standalone emoticons into emoji, longest first', () => {
    expect(convertEmoticons('hi :) and :( >:( <3')).toBe('hi 🙂 and 😦 😠 ❤️');
    expect(convertEmoticons(':D')).toBe('😄');
    expect(convertEmoticons(':) :)')).toBe('🙂 🙂');
  });

  it('leaves emoticons inside words, links and code as typed', () => {
    expect(convertEmoticons('a:)b http://x.com/:)')).toBe('a:)b http://x.com/:)');
    expect(convertEmoticons('`:)` and ```\n:)\n``` then :)')).toBe('`:)` and ```\n:)\n``` then 🙂');
  });
});
