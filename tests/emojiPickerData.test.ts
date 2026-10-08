import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { rankEmojiFavorites } from '../src/renderer/src/panels/chat/compose/emojiFavorites';
import { DiscordEmojiPickerData, emojiFavoritesFromProto } from '../src/main/discord/emojiPickerData';
import type { DiscordReader } from '../src/main/discord/client';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { bytesField } from '../src/main/discord/settingsProto';
import { DM_GUILD_ID } from '@shared/discord';

const favorites = (...keys: string[]): Buffer => bytesField(5, Buffer.concat(keys.map((key) => bytesField(1, Buffer.from(key)))));
const settings = (...keys: string[]) => ({ settings: favorites(...keys).toString('base64') });
function harness(get: ReturnType<typeof vi.fn>) {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const data = new DiscordEmojiPickerData(tap as unknown as GatewayTap, { get } as unknown as DiscordReader);
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
