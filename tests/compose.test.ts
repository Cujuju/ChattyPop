import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ALT_TEXT_MAX, canUseEmoji, canUseSticker, emojiToken, expandEmojiTokens, expandMentionTokens, mentionToken, pickedMentionNames, planPerks, type MentionPick, type OwnerMessage } from '@shared/compose';
import { DISCORD_FILES_PER_MESSAGE_MAX, DISCORD_TEXT_MAX, DISCORD_UPLOAD_BYTES_MAX } from '@shared/discord';
import type { CustomEmoji, GuildEmoji } from '@shared/emoji';
import { OwnerAccount } from '../src/main/discord/account';
import type { DiscordApi } from '../src/main/discord/api';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { deleteOwnerMessage, editOwnerMessage, forwardAsOwner, reactAsOwner, sendOwnerMessage } from '../src/main/discord/send';
import { GuildStickerIndex } from '../src/main/discord/stickers';
import { ownEmoji, ownReactions } from '../src/core/queries/ownEmoji';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CHANNEL = '200000000000000001';
const MESSAGE = '300000000000000001';
const STICKER = '400000000000000001';

/** Records POSTs and PUT uploads with configured Discord responses. */
function fakeApi() {
  const posts: [string, Record<string, unknown>][] = [];
  const uploads: string[] = [];
  const api = {
    post: async (path: string, body: Record<string, unknown>) => {
      posts.push([path, body]);
      if (path.endsWith('/attachments')) {
        const files = body['files'] as { id: string; filename: string }[];
        return { attachments: files.map((f) => ({ id: f.id, upload_url: `https://upload/${f.filename}`, upload_filename: `up/${f.filename}` })) };
      }
      return { id: String(posts.length) };
    },
    upload: async (url: string) => void uploads.push(url),
  } as unknown as DiscordApi;
  return { api, posts, uploads };
}

const NONCE = '1300000000000000000';
const message = (m: Partial<OwnerMessage> = {}): OwnerMessage => ({ channelId: CHANNEL, text: 'hi', replyTo: null, files: [], stickerId: null, gif: null, nonce: NONCE, ...m });
const file = (name: string, size = 3) => ({ name, bytes: new Uint8Array(size) });

describe('owner messages from the composer', () => {
  it('posts text as the client does; a reply carries the reference and its @ON/@OFF', async () => {
    const { api, posts } = fakeApi();
    await sendOwnerMessage(api, message({ text: 'on it', replyTo: { messageId: MESSAGE, ping: false } }));
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(`channels/${CHANNEL}/messages`);
    expect(posts[0]![1]).toMatchObject({
      content: 'on it',
      // The sender's nonce, so its retry can't post twice.
      nonce: NONCE,
      enforce_nonce: true,
      allowed_mentions: { parse: ['users', 'roles', 'everyone'], replied_user: false },
      message_reference: { channel_id: CHANNEL, message_id: MESSAGE },
    });
    expect(posts[0]![1]).not.toHaveProperty('sticker_ids');
  });

  it('uploads files to the slots Discord hands out, then references them in the message', async () => {
    const { api, posts, uploads } = fakeApi();
    await sendOwnerMessage(api, message({ text: '', files: [file('a.png'), file('b.txt')] }));
    expect(posts.map(([p]) => p)).toEqual([`channels/${CHANNEL}/attachments`, `channels/${CHANNEL}/messages`]);
    expect(uploads).toEqual(['https://upload/a.png', 'https://upload/b.txt']);
    expect(posts[1]![1]['attachments']).toEqual([
      { id: '0', filename: 'a.png', uploaded_filename: 'up/a.png' },
      { id: '1', filename: 'b.txt', uploaded_filename: 'up/b.txt' },
    ]);
  });

  it('sends a sticker alone or with text, and reports a picked GIF before posting its URL', async () => {
    const { api, posts } = fakeApi();
    await sendOwnerMessage(api, message({ text: '', stickerId: STICKER }));
    expect(posts[0]![1]).toMatchObject({ content: '', sticker_ids: [STICKER] });
    await sendOwnerMessage(api, message({ text: 'https://klipy.com/gifs/x', gif: { id: 'g1', query: 'cat' } }));
    expect(posts[1]).toEqual(['gifs/select', { id: 'g1', q: 'cat' }]);
    expect(posts[2]![1]).toMatchObject({ content: 'https://klipy.com/gifs/x' });
  });

  it('refuses what Discord would, before any request', async () => {
    const { api, posts } = fakeApi();
    await expect(sendOwnerMessage(api, message({ text: '  ' }))).rejects.toThrow(/Write a message/);
    await expect(sendOwnerMessage(api, message({ channelId: '../x' }))).rejects.toThrow(/Not a channel id/);
    await expect(sendOwnerMessage(api, message({ text: 'x'.repeat(DISCORD_TEXT_MAX + 1) }))).rejects.toThrow(/allows/);
    await expect(sendOwnerMessage(api, message({ replyTo: { messageId: 'nope', ping: true } }))).rejects.toThrow(/Not a message id/);
    await expect(sendOwnerMessage(api, message({ stickerId: '1/2' }))).rejects.toThrow(/Not a sticker id/);
    await expect(sendOwnerMessage(api, message({ files: [file('big.mp4', DISCORD_UPLOAD_BYTES_MAX + 1)] }))).rejects.toThrow(/big\.mp4 is over/);
    const many = Array.from({ length: DISCORD_FILES_PER_MESSAGE_MAX + 1 }, (_, i) => file(`${i}.png`));
    await expect(sendOwnerMessage(api, message({ files: many }))).rejects.toThrow(/up to/);
    await expect(sendOwnerMessage(api, { ...message(), files: [{ name: 'x', bytes: 'not bytes' }] })).rejects.toThrow(/Not a file/);
    await expect(sendOwnerMessage(api, null)).rejects.toThrow(/Not a message/);
    await expect(sendOwnerMessage(api, { ...message(), nonce: undefined })).rejects.toThrow(/Not a nonce id/);
    expect(posts).toHaveLength(0);
  });
});

describe('owner edits', () => {
  /** A DiscordApi that records each PATCH. */
  function patchApi() {
    const patches: [string, unknown][] = [];
    const api = { patch: async (path: string, body: unknown) => void patches.push([path, body]) } as unknown as DiscordApi;
    return { api, patches };
  }

  it('patches only the content of that message, as the web client does', async () => {
    const { api, patches } = patchApi();
    await editOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE, text: 'fixed typo' });
    expect(patches).toEqual([[`channels/${CHANNEL}/messages/${MESSAGE}`, { content: 'fixed typo' }]]);
  });

  it('refuses a bad id or over-long text, before any request', async () => {
    const { api, patches } = patchApi();
    await expect(editOwnerMessage(api, { channelId: CHANNEL, messageId: '../x', text: 'a' })).rejects.toThrow(/Not a message id/);
    await expect(editOwnerMessage(api, { channelId: 'x', messageId: MESSAGE, text: 'a' })).rejects.toThrow(/Not a channel id/);
    await expect(editOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE, text: 'x'.repeat(DISCORD_TEXT_MAX + 1) })).rejects.toThrow(/allows/);
    await expect(editOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE })).rejects.toThrow(/Not an edit/);
    expect(patches).toHaveLength(0);
  });

  it("patches only the kept attachments, as the web client's Modify does: ids, and the changed one's alt text and spoiler flag", async () => {
    const { api, patches } = patchApi();
    const kept = [{ id: '300000000000000001', change: { description: 'a chart', spoiler: true } }, { id: '300000000000000002' }];
    await editOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE, attachments: kept });
    expect(patches).toEqual([
      [`channels/${CHANNEL}/messages/${MESSAGE}`, { attachments: [{ id: '300000000000000001', description: 'a chart', is_spoiler: true }, { id: '300000000000000002' }] }],
    ]);
  });

  it('refuses a bad attachment id, change or over-long alt text, before any request', async () => {
    const { api, patches } = patchApi();
    const edit = (a: unknown) => editOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE, attachments: [a] as never });
    await expect(edit({ id: '../x' })).rejects.toThrow(/attachment id/);
    await expect(edit({ id: '300000000000000001', change: { description: null, spoiler: false } })).rejects.toThrow(/Not an attachment change/);
    await expect(edit({ id: '300000000000000001', change: { description: 'x'.repeat(ALT_TEXT_MAX + 1), spoiler: false } })).rejects.toThrow(/alt text/);
    expect(patches).toHaveLength(0);
  });
});

describe('owner deletes', () => {
  it('deletes that message, and refuses a bad id before any request', async () => {
    const deletes: string[] = [];
    const api = { delete: async (path: string) => void deletes.push(path) } as unknown as DiscordApi;
    await deleteOwnerMessage(api, { channelId: CHANNEL, messageId: MESSAGE });
    await expect(deleteOwnerMessage(api, { channelId: CHANNEL, messageId: '1/2' })).rejects.toThrow(/Not a message id/);
    await expect(deleteOwnerMessage(api, null)).rejects.toThrow(/Not a message/);
    expect(deletes).toEqual([`channels/${CHANNEL}/messages/${MESSAGE}`]);
  });
});

describe('owner forwards', () => {
  const TARGET = '200000000000000002';
  const GUILD = '100000000000000001';
  const source = { channelId: CHANNEL, messageId: MESSAGE, guildId: GUILD };

  it('posts a forward reference (type 1) to the target with the sender’s nonce', async () => {
    const { api, posts } = fakeApi();
    await forwardAsOwner(api, { source, channelId: TARGET, nonce: NONCE });
    expect(posts.map(([path]) => path)).toEqual([`channels/${TARGET}/messages`]);
    // The sender's nonce, so a retry can't post it twice.
    expect(posts[0]![1]).toMatchObject({ content: '', nonce: NONCE, enforce_nonce: true, message_reference: { type: 1, channel_id: CHANNEL, message_id: MESSAGE, guild_id: GUILD } });
  });

  it('names no guild for a DM, and refuses what is not a forward or has no nonce', async () => {
    const { api, posts } = fakeApi();
    await forwardAsOwner(api, { source: { ...source, guildId: '@me' }, channelId: TARGET, nonce: NONCE });
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]['message_reference']).toEqual({ type: 1, channel_id: CHANNEL, message_id: MESSAGE });
    await expect(forwardAsOwner(api, { source, channelId: 'x', nonce: NONCE })).rejects.toThrow();
    await expect(forwardAsOwner(api, { source, channelId: TARGET })).rejects.toThrow();
    await expect(forwardAsOwner(api, { channelId: TARGET, nonce: NONCE })).rejects.toThrow(/Not a message to forward/);
    expect(posts).toHaveLength(1);
  });
});

describe('owner reactions', () => {
  it('PUTs a reaction and DELETEs it back, with a custom emoji as name:id', async () => {
    const calls: string[] = [];
    const api = { put: async (p: string) => void calls.push(`PUT ${p}`), delete: async (p: string) => void calls.push(`DELETE ${p}`) } as unknown as DiscordApi;
    const base = `channels/${CHANNEL}/messages/${MESSAGE}/reactions`;
    await reactAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, emoji: { id: null, name: '👍', animated: false }, add: true });
    await reactAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, emoji: { id: STICKER, name: 'pog', animated: false }, add: false });
    expect(calls).toEqual([`PUT ${base}/${encodeURIComponent('👍')}/@me`, `DELETE ${base}/${encodeURIComponent(`pog:${STICKER}`)}/@me`]);
    await expect(reactAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, emoji: { id: 'x', name: 'pog', animated: false }, add: true })).rejects.toThrow(/Not a reaction/);
    await expect(reactAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, emoji: { id: null, name: '👍', animated: false } })).rejects.toThrow(/Not a reaction/);
    expect(calls).toHaveLength(2);
  });
});

describe('what the plan allows', () => {
  const own: GuildEmoji = { id: '1', name: 'pog', animated: false, guildId: 'g1' };
  const animated: GuildEmoji = { ...own, id: '2', animated: true };
  const other: GuildEmoji = { ...own, id: '3', guildId: 'g2' };

  it("follows Discord's perk table: Classic and Basic unlock emoji, Nitro and Basic stickers", () => {
    expect(planPerks(0)).toEqual({ animatedEmoji: false, emojiEverywhere: false, stickersEverywhere: false });
    expect(planPerks(1)).toEqual({ animatedEmoji: true, emojiEverywhere: true, stickersEverywhere: false });
    expect(planPerks(2)).toEqual({ animatedEmoji: true, emojiEverywhere: true, stickersEverywhere: true });
    expect(planPerks(3)).toEqual({ animatedEmoji: true, emojiEverywhere: true, stickersEverywhere: true });
  });

  it('without Nitro: only this server’s still emoji and stickers, and every standard sticker', () => {
    const free = planPerks(0);
    expect([own, animated, other].map((e) => canUseEmoji(e, 'g1', free))).toEqual([true, false, false]);
    expect(canUseEmoji(own, '@me', free)).toBe(false);
    expect(canUseSticker({ id: 's', name: 's', formatType: 1, tags: '', guildId: 'g2' }, 'g1', free)).toBe(false);
    expect(canUseSticker({ id: 's', name: 's', formatType: 3, tags: '' }, 'g1', free)).toBe(true);
    expect([own, animated, other].every((e) => canUseEmoji(e, 'g1', planPerks(2)))).toBe(true);
  });

  it('reads the plan from READY and follows USER_UPDATE for the same account', () => {
    const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
    const account = new OwnerAccount(tap as unknown as GatewayTap);
    const send = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, s: null, d });
    send('READY', { user: { id: 'u1', premium_type: 0 } });
    expect(account.perks.emojiEverywhere).toBe(false);
    send('USER_UPDATE', { id: 'u1', premium_type: 2 });
    expect(account.perks.stickersEverywhere).toBe(true);
    send('READY', { user: { id: 'u2' } });
    expect(account.perks.emojiEverywhere).toBe(false);
  });
});

describe('custom emoji in the composer text', () => {
  it('shows :name: while typing and sends the markup; a second emoji of the same name gets ~1', () => {
    const picked = new Map<string, CustomEmoji>();
    const a: CustomEmoji = { id: '10', name: 'pog', animated: false };
    const b: CustomEmoji = { id: '11', name: 'pog', animated: true };
    expect(emojiToken(a, picked)).toBe(':pog:');
    expect(emojiToken(b, picked)).toBe(':pog~1:');
    expect(emojiToken(a, picked)).toBe(':pog:');
    expect(expandEmojiTokens('gg :pog: :pog~1: :smile: :pog', picked)).toBe('gg <:pog:10> <a:pog:11> :smile: :pog');
  });
});

describe('people mentioned in the composer text', () => {
  it('shows @username while typing and sends the mention; only whole picked names become mentions', () => {
    const picked = new Map<string, MentionPick>();
    expect(mentionToken('bob', { id: '1', kind: 'user' }, picked)).toBe('@bob');
    expect(mentionToken('bob.smith', { id: '2', kind: 'user' }, picked)).toBe('@bob.smith');
    expect(mentionToken('bob', { id: '3', kind: 'user' }, picked)).toBe('@bob~1');
    expect(expandMentionTokens('hi @bob, @bob.smith and @bob~1. @bobby a@bob @bob.x @bob.', picked)).toBe('hi <@1>, <@2> and <@3>. @bobby a@bob @bob.x <@1>.');
    expect(expandMentionTokens('@bob', new Map())).toBe('@bob');
  });

  it("sends a picked role as Discord's role mention, its name as typed; @everyone and @here stay text", () => {
    const picked = new Map<string, MentionPick>();
    expect(mentionToken('Game Night', { id: '9', kind: 'role' }, picked)).toBe('@Game Night');
    expect(mentionToken('bob', { id: '1', kind: 'user' }, picked)).toBe('@bob');
    expect(mentionToken('bob', { id: '8', kind: 'role' }, picked)).toBe('@bob~1');
    expect(expandMentionTokens('@Game Night @bob @bob~1 @everyone @here', picked)).toBe('<@&9> <@1> <@&8> @everyone @here');
    // A role named "everyone" can't take the text Discord pings everyone by.
    expect(mentionToken('everyone', { id: '7', kind: 'role' }, picked)).toBe('@everyone~1');
    expect(expandMentionTokens('@everyone @everyone~1', picked)).toBe('@everyone <@&7>');
  });

  it('keeps a picked name inside a longer one in any script', () => {
    const picked = new Map<string, MentionPick>([
      ['bob', { id: '1', kind: 'user' }],
      ['ann', { id: '2', kind: 'user' }],
    ]);
    expect(expandMentionTokens('@bobé @bob日本 é@ann @bob.ü @ann!', picked)).toBe('@bobé @bob日本 é@ann @bob.ü <@2>!');
  });

  it('sends a person picked into a draft saved before roles (no kind) as a user mention', () => {
    const saved: [string, MentionPick][] = JSON.parse('[["bob", {"id": "1"}]]');
    expect(expandMentionTokens('hi @bob', new Map(saved))).toBe('hi <@1>');
  });

  it("names picked people by id for a message still sending; roles and picks saved without a name aren't named", () => {
    const picked = new Map<string, MentionPick>([['bob~1', { id: '9', kind: 'role' }], ['ann', { id: '2' }]]);
    mentionToken('bob', { id: '1', kind: 'user', name: 'Bobby' }, picked);
    expect(pickedMentionNames(picked)).toEqual({ '1': 'Bobby' });
  });
});

describe('frequently used emoji', () => {
  it("counts the owner's own emoji, custom and Unicode (whole sequences), most used then most recent first", () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1', name: 'general' }]);
    const ME = { id: 'me', username: 'me' };
    archive.ingestMessages(
      [
        rawMessage('c1', 1_000, 'old 😂', { author: ME }),
        rawMessage('c1', 2_000, 'gg <:pog:500000000000000010> 👍🏽', { author: ME }),
        rawMessage('c1', 3_000, '<a:dance:500000000000000011> <:pog:500000000000000010> 🇺🇸', { author: ME }),
        rawMessage('c1', 4_000, '😂😂 not mine <:pog:500000000000000010>'),
      ],
      ARRIVAL.sync,
    );
    expect(ownEmoji(db, 'me', 4)).toEqual([
      { custom: { animated: false, name: 'pog', id: '500000000000000010' } },
      { custom: { animated: true, name: 'dance', id: '500000000000000011' } },
      { unicode: '🇺🇸' },
      { unicode: '👍🏽' },
    ]);
    expect(ownEmoji(db, 'nobody', 4)).toEqual([]);
  });

  it("counts the owner's reactions on anyone's messages, most used then most recent first; others' don't count", () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1', name: 'general' }]);
    const r = (name: string, me: boolean, id: string | null = null, animated = false) => ({ emoji: { id, name, animated }, count: 2, me });
    const pog = '500000000000000010';
    archive.ingestMessages(
      [
        rawMessage('c1', 1_000, 'a', { reactions: [r('😂', true), r('👍', false)] } as never),
        rawMessage('c1', 2_000, 'b', { reactions: [r('pog', true, pog), r('🔥', true)] } as never),
        rawMessage('c1', 3_000, 'c', { reactions: [r('pog', true, pog), r('😂', true)] } as never),
        rawMessage('c1', 4_000, 'd', { reactions: [r('🔥', true), r('pog', true, pog), r('👀', false)] } as never),
        rawMessage('c1', 5_000, 'e', { reactions: [r('dance', true, '500000000000000011', true)] } as never),
      ],
      ARRIVAL.sync,
    );
    expect(ownReactions(db, 3)).toEqual([
      { id: '500000000000000010', name: 'pog', animated: false },
      { id: null, name: '🔥', animated: false },
      { id: null, name: '😂', animated: false },
    ]);
    expect(ownReactions(db, 10).map((e) => e.name)).toEqual(['pog', '🔥', '😂', 'dance']);
  });
});

describe('sticker index', () => {
  it("indexes every server's usable stickers from the gateway and follows sticker edits", () => {
    const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
    const index = new GuildStickerIndex(tap as unknown as GatewayTap);
    const send = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, s: null, d });
    send('READY', { guilds: [{ id: 'g1', stickers: [{ id: '2', name: 'zed', format_type: 1, tags: 'z' }, { id: '1', name: 'gone', format_type: 1, available: false }] }] });
    expect(index.all()).toEqual([{ id: '2', name: 'zed', formatType: 1, tags: 'z', guildId: 'g1' }]);
    send('GUILD_STICKERS_UPDATE', { guild_id: 'g1', stickers: [{ id: '3', name: 'new', format_type: 3 }] });
    expect(index.all().map((s) => s.name)).toEqual(['new']);
  });
});
