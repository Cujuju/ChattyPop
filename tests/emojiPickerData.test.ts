import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { rankEmojiFavorites } from '../src/renderer/src/panels/chat/compose/emojiFavorites';
import { DiscordEmojiPickerData, emojiFavoritesFromProto, emojiFavoritesPatch } from '../src/main/discord/emojiPickerData';
import type { DiscordClient } from '../src/main/discord/client';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { bytesField, fields, varintField } from '../src/main/discord/settingsProto';
import { DM_GUILD_ID } from '@shared/discord';
import { isFavoriteEmoji, withFavoriteEmoji } from '@shared/emoji';

const favorites = (...keys: string[]): Buffer => bytesField(5, Buffer.concat(keys.map((key) => bytesField(1, Buffer.from(key)))));
const settings = (...keys: string[]) => ({ settings: favorites(...keys).toString('base64') });
function harness(get: ReturnType<typeof vi.fn>, patch: ReturnType<typeof vi.fn> = vi.fn()) {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const data = new DiscordEmojiPickerData(tap as unknown as GatewayTap, { get, patch } as unknown as DiscordClient);
  const update = (proto: Buffer, partial = true) => tap.emit('dispatch', { t: 'USER_SETTINGS_PROTO_UPDATE', s: null, d: { partial, settings: { type: 2, proto: proto.toString('base64') } } });
  return { data, update, tap };
}

describe('mirrored Discord emoji picker data', () => {
  it('reads exact custom ids and system shortcodes, deduplicates, and distinguishes absent from empty', () => {
    expect(emojiFavoritesFromProto(favorites('9007199254740993123', 'fire', 'fire'))).toEqual(['9007199254740993123', 'fire']);
    expect(emojiFavoritesFromProto(bytesField(2, Buffer.alloc(0)))).toBeNull();
    expect(emojiFavoritesFromProto(favorites())).toEqual([]);
    expect(() => emojiFavoritesFromProto(Buffer.from([42, 100]))).toThrow();
  });

  it('reads through the supplied session API, preserves Discord ranking, and caches repeat openings', async () => {
    const get = vi.fn(async (path: string) => path.endsWith('/2') ? settings('fire') : { items: [{ emoji_id: 'b', emoji_rank: 2 }, { emoji_id: 'a', emoji_rank: 1 }] });
    const { data } = harness(get);
    expect(await data.get('g')).toEqual({ favorites: ['fire'], popular: ['a', 'b'] });
    await data.get('g');
    expect(get.mock.calls.map(([path]) => path)).toEqual(['users/@me/settings-proto/2', 'guilds/g/top-emojis']);
  });

  it('adopts live favorite updates, ignores unrelated partials, and mirrors clearing', async () => {
    const get = vi.fn(async () => settings('old'));
    const { data, update } = harness(get);
    await data.get(DM_GUILD_ID);
    update(favorites('new', 'fire'));
    update(bytesField(2, Buffer.alloc(0)));
    expect((await data.get(DM_GUILD_ID)).favorites).toEqual(['new', 'fire']);
    update(favorites());
    expect((await data.get(DM_GUILD_ID)).favorites).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps newer gateway favorites when an older HTTP read resolves late', async () => {
    let resolve!: (value: ReturnType<typeof settings>) => void;
    const get = vi.fn(() => new Promise((done) => { resolve = done; }));
    const { data, update } = harness(get);
    const reading = data.get(DM_GUILD_ID);
    update(favorites('newer'));
    resolve(settings('stale'));
    expect((await reading).favorites).toEqual(['newer']);
  });

  it('isolates optional section failures and retries failed reads', async () => {
    const get = vi.fn(async (path: string) => { if (path.endsWith('/2')) throw new Error('offline'); return { items: [] }; });
    const { data } = harness(get);
    expect(await data.get('g')).toEqual({ favorites: [], popular: [], favoritesError: 'offline' });
    await data.get('g');
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('favorite ordering', () => {
  it('raises recent picks over frequent ones and retains Discord order for untouched favorites', () => {
    const saved = ['unused-1', 'frequent', 'recent', 'unused-2'];
    expect(rankEmojiFavorites(saved, (k) => k, ['recent', 'not-favorite'], ['frequent', 'recent'])).toEqual(['recent', 'frequent', 'unused-1', 'unused-2']);
    expect(saved).toEqual(['unused-1', 'frequent', 'recent', 'unused-2']);
  });
});

describe('favorite membership', () => {
  it('appends a new favorite, removes every spelling of one, and keeps the rest in order', () => {
    expect(withFavoriteEmoji(['a', 'fire'], { id: 'b' }, true)).toEqual(['a', 'fire', 'b']);
    expect(withFavoriteEmoji(['a', 'b'], { id: 'a' }, true)).toEqual(['a', 'b']);
    expect(withFavoriteEmoji(['a', ':fire:', 'flame', 'b'], { names: ['fire', 'flame'] }, false)).toEqual(['a', 'b']);
    expect(withFavoriteEmoji(['a'], { names: ['thumbsup', '+1'] }, true)).toEqual(['a', 'thumbsup']);
    expect(isFavoriteEmoji([':fire:'], { names: ['fire'] })).toBe(true);
    expect(isFavoriteEmoji(['fire'], { id: 'fire2' })).toBe(false);
  });

  it('rewrites only favorite_emojis, keeping its other fields byte for byte', () => {
    const unknownField = varintField(2, 1);
    const current = Buffer.concat([bytesField(3, Buffer.from('other')), bytesField(5, Buffer.concat([bytesField(1, Buffer.from('old')), unknownField]))]);
    const patch = emojiFavoritesPatch(current, ['x', 'fire']);
    expect(fields(patch).map((f) => f.no)).toEqual([5]);
    expect(emojiFavoritesFromProto(patch)).toEqual(['x', 'fire']);
    expect(patch.includes(unknownField)).toBe(true);
    expect(emojiFavoritesFromProto(emojiFavoritesPatch(current, []))).toEqual([]);
  });
});

describe('writing favorites', () => {
  const decoded = (body: { settings: string }): string[] => emojiFavoritesFromProto(Buffer.from(body.settings, 'base64')) ?? [];

  it("writes over a fresh read, adopts Discord's answer, and serves it without reading again", async () => {
    const get = vi.fn(async () => settings('a', 'fire'));
    const patch = vi.fn(async (_path: string, body: { settings: string }) => ({ settings: favorites(...decoded(body)).toString('base64') }));
    const { data } = harness(get, patch);
    expect(await data.setFavorite({ emoji: { id: 'b' }, favorite: true })).toEqual(['a', 'fire', 'b']);
    expect(patch.mock.calls[0]![0]).toBe('users/@me/settings-proto/2');
    expect(decoded(patch.mock.calls[0]![1])).toEqual(['a', 'fire', 'b']);
    expect((await data.get(DM_GUILD_ID)).favorites).toEqual(['a', 'fire', 'b']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('runs writes one at a time, each over the result of the last', async () => {
    let held = ['a'];
    const get = vi.fn(async () => settings(...held));
    const patch = vi.fn(async (_path: string, body: { settings: string }) => {
      await new Promise((r) => setTimeout(r));
      held = decoded(body);
      return {};
    });
    const { data } = harness(get, patch);
    await Promise.all([data.setFavorite({ emoji: { id: 'b' }, favorite: true }), data.setFavorite({ emoji: { id: 'a' }, favorite: false })]);
    expect(held).toEqual(['b']);
  });

  it("rejects with Discord's refusal and keeps the next write going", async () => {
    const get = vi.fn(async () => settings('a'));
    const patch = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue({});
    const { data } = harness(get, patch);
    await expect(data.setFavorite({ emoji: { id: 'b' }, favorite: true })).rejects.toThrow('refused');
    expect(await data.setFavorite({ emoji: { id: 'c' }, favorite: true })).toEqual(['a', 'c']);
  });
});
