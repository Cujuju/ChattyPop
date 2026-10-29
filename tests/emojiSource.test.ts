import { describe, expect, it, vi } from 'vitest';
import { DiscordHttpError, type RawGuild } from '@shared/discord';
import type { GuildEmoji } from '@shared/emoji';
import { EmojiSources } from '../src/main/discord/emojiSource';
import type { DiscordReader } from '../src/main/discord/client';
import { emojiBlurb, emojiOrigin, serverKind } from '../src/renderer/src/panels/chat/emojiBlurb';

const guilds: RawGuild[] = [{ id: 'g1', name: 'Mine', icon: 'i', features: ['DISCOVERABLE'] }, { id: 'g2', name: 'Also mine' }];
const emojis: GuildEmoji[] = [{ id: 'e1', name: 'pog', animated: false, guildId: 'g1' }];
const sources = (get: ReturnType<typeof vi.fn>) => new EmojiSources({ get } as unknown as DiscordReader, { all: () => emojis }, () => guilds);

describe('emoji sources', () => {
  it("names the owner's own server from the gateway, without asking Discord", async () => {
    const get = vi.fn();
    expect(await sources(get).of('e1')).toEqual({ guild: { id: 'g1', name: 'Mine', icon: 'i', discoverable: true }, joined: true });
    expect(get).not.toHaveBeenCalled();
  });

  it("asks Discord once for another server's emoji, and reads a server the owner is in as joined", async () => {
    const get = vi.fn(async (): Promise<unknown> => ({ type: 'GUILD', guild: { id: 'g9', name: 'Public', icon: null, features: ['DISCOVERABLE'] } }));
    const s = sources(get);
    expect(await s.of('e9')).toEqual({ guild: { id: 'g9', name: 'Public', icon: null, discoverable: true }, joined: false });
    await s.of('e9');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('emojis/e9/source');
    get.mockResolvedValueOnce({ type: 'GUILD', guild: { id: 'g2', name: 'Also mine' } });
    expect((await s.of('e8')).joined).toBe(true);
  });

  it('keeps a refusal as no server named, and asks again after a failure', async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new DiscordHttpError('Unknown Emoji', 404))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ type: 'APPLICATION' });
    const s = sources(get);
    expect(await s.of('e7')).toEqual({ guild: null, joined: false });
    expect(await s.of('e7')).toEqual({ guild: null, joined: false });
    await expect(s.of('e6')).rejects.toThrow('offline');
    expect(await s.of('e6')).toEqual({ guild: null, joined: false });
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('emoji popout copy', () => {
  const g = { id: 'g1', name: 'Mine', icon: null, discoverable: false };

  it("places the emoji as Discord does, seen from the channel's server", () => {
    expect(emojiOrigin({ guild: g, joined: true }, 'g1')).toBe('here');
    expect(emojiOrigin({ guild: g, joined: true }, 'g2')).toBe('yours');
    expect(emojiOrigin({ guild: g, joined: true }, undefined)).toBe('yours');
    expect(emojiOrigin({ guild: g, joined: false }, 'g1')).toBe('joinable');
    expect(emojiOrigin({ guild: null, joined: false }, 'g1')).toBe('unknown');
  });

  it('says what the plan allows', () => {
    expect(emojiBlurb('here', true)).toBe('This emoji is from this server. You can use it everywhere.');
    expect(emojiBlurb('here', false)).toBe('This emoji is from this server. Get Nitro to use it everywhere.');
    expect(emojiBlurb('joinable', false)).toBe('Want to use this emoji everywhere? Get Nitro and join the server.');
    expect(serverKind(g)).toBe('Invite-only server');
    expect(serverKind({ ...g, discoverable: true })).toBe('Discoverable Server');
  });
});
