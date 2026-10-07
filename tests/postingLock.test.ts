// Posting locks gate window, phone, and plugin writes before each attempt. Enabled unlocking plugins release the gate; disabling restores it. Reads, reactions, and acknowledgements remain available.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_INVOKE } from '@shared/contract';
import { PHONE_DISCORD_METHODS } from '@shared/phone';
import type { PluginInfo } from '@shared/plugins';
import { POSTING_CALLS, PostingLocked, isPostingCall, isPostingLocked, keepPostingLocked } from '@shared/posting';
import type { DiscordClient, RequestOptions } from '../src/main/discord/client';

const env = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  manifest: (id: string) => ({ id, name: id, version: '1.0.0', description: '' }),
}));
vi.mock('virtual:bundled-plugins/shared', () => ({
  default: [{ manifest: env.manifest('unlocker'), unlocks: { posting: true } }, { manifest: env.manifest('writer'), discord: { write: true } }],
  catalog: null,
}));
vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: (channel: string, fn: never) => void env.handlers.set(channel, fn) } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined, redactIds: (s: string) => s }));

const { BUNDLED_PLUGINS } = await import('@shared/bundledPlugins');
const { registerDiscordHandlers } = await import('../src/main/ipc/discord');
const { PhoneHub } = await import('../src/main/phone/hub');
const { exemptWrite, postingGate } = await import('../src/main/plugins/posting');
const { ActionSpacer, pluginDiscord } = await import('../src/main/plugins/discordContext');
const { sendMessage } = await import('../src/main/discord/send');
const { ReadStates } = await import('../src/main/discord/readStates');

const CHANNEL = '100000000000000001';
const MESSAGE = '200000000000000002';
const ref = { channelId: CHANNEL, messageId: MESSAGE };
const REACTION = `channels/${CHANNEL}/messages/${MESSAGE}/reactions/%F0%9F%91%8D/@me`;
const ACK = `channels/${CHANNEL}/messages/${MESSAGE}/ack`;
/** Calls that write but are exempt from the lock (owner's choice), and reads, which aren't writes. */
const EXEMPT = ['react', 'setChatSettings'];
const READS = ['refreshDirectory', 'customTheme', 'suggestChannels', 'setOptIn', 'gifs', 'expressions', 'commands', 'roles', 'requestMembers', 'profile', 'mutualFriends', 'reactors', 'uploadLimit', 'shownChannel', 'probe', 'friends'];

const info = (id: string, status: PluginInfo['status']): PluginInfo =>
  ({ key: id, conflict: false, id, name: id, version: '1.0.0', description: null, dir: '', bundled: true, origin: 'bundled', status, error: null, commands: [], renderer: null }) as PluginInfo;
const LOCKED = [info('unlocker', 'disabled'), info('writer', 'active')];
const UNLOCKED = [info('unlocker', 'active'), info('writer', 'active')];

/** The host's client: as DiscordApi does, it runs each request's guard after `queued` (the queue wait), then records it. */
function owner(queued: () => void = () => undefined): DiscordClient & { sent: string[] } {
  const sent: string[] = [];
  const record = (verb: string) => async (path: string, a?: unknown, b?: unknown) => {
    queued();
    await ((verb === 'put' || verb === 'delete' ? a : b) as RequestOptions | undefined)?.guard?.();
    sent.push(`${verb} ${path}`);
    return { id: MESSAGE, attachments: [] };
  };
  return { sent, get: async <T>() => [] as T, post: record('post') as never, postOnce: record('postOnce') as never, put: record('put'), putJson: record('putJson') as never, patch: record('patch') as never, delete: record('delete'), upload: record('upload') as never };
}

/** The real registrations over fakes; `state.list` is core's plugin list as the gate reads it, changeable mid-test. */
function setup(queued?: (state: { list: PluginInfo[] }) => void) {
  env.handlers.clear();
  const state = { list: LOCKED };
  const api = owner(() => queued?.(state));
  const core = { call: vi.fn(async (_method: string, ...args: unknown[]) => args[0]) };
  const calls = registerDiscordHandlers({
    win: {} as never,
    core: core as never,
    sync: {} as never,
    owner: api,
    capture: {} as never,
    discordSession: {} as never,
    discord: { tap: new EventEmitter(), webContents: { debugger: {} }, shownChannel: null } as never,
    emojiIndex: {} as never,
    readStates: { settingsChanged: () => undefined },
    posting: postingGate(async () => state.list),
    chatSettings: { write: async () => undefined },
    directory: { guildList: () => [] },
  });
  const hub = new PhoneHub({ core: core as never, discord: () => calls, main: async () => undefined, media: async () => new Response(), active: () => true });
  const invoke = (name: keyof typeof MAIN_INVOKE.discord, ...args: unknown[]) => env.handlers.get(MAIN_INVOKE.discord[name])!({}, ...args);
  return { state, api, core, invoke, phone: hub.gateway };
}

describe('the host posting calls', () => {
  it('classifies every Discord channel: each is gated, exempt or a read', () => {
    setup();
    const registered = Object.entries(MAIN_INVOKE.discord).filter(([, channel]) => env.handlers.has(channel)).map(([name]) => name);
    expect(registered.sort()).toEqual([...POSTING_CALLS, ...EXEMPT, ...READS].sort());
    for (const name of [...EXEMPT, ...READS]) expect(isPostingCall(name)).toBe(false);
  });

  it('locked by default: every posting call refuses from a window and from the phone, and nothing reaches Discord', async () => {
    const { api, invoke, phone } = setup();
    for (const name of POSTING_CALLS) await expect(invoke(name, ref), name).rejects.toBeInstanceOf(PostingLocked);
    for (const name of PHONE_DISCORD_METHODS.filter(isPostingCall)) await expect(phone.call('discord', name, [ref]), name).rejects.toBeInstanceOf(PostingLocked);
    expect(api.sent).toEqual([]);
  });

  it('reactions, added and taken back, work while locked', async () => {
    const { api, core, invoke, phone } = setup();
    const reaction = { ...ref, emoji: { id: null, name: '👍', animated: false }, add: true };
    await invoke('react', reaction);
    await phone.call('discord', 'react', [{ ...reaction, add: false }]);
    expect(api.sent).toEqual([`put ${REACTION}`, `delete ${REACTION}`]);
    expect(core.call).toHaveBeenCalledWith('applyOwnReaction', reaction);
  });

  it('read acks work while locked: they never consult the lock', async () => {
    const api = owner();
    new ReadStates(new EventEmitter() as never, api, () => undefined, () => undefined).ack(CHANNEL, MESSAGE);
    await vi.waitFor(() => expect(api.sent).toEqual([`post ${ACK}`]));
  });

  it('a plugin declaring the unlock unlocks while it is on; turning it off locks again', async () => {
    const { state, api, invoke, phone } = setup();
    const edit = { ...ref, text: 'fixed' };
    state.list = UNLOCKED;
    await invoke('edit', edit);
    await phone.call('discord', 'deleteMessage', [ref]);
    expect(api.sent).toEqual([`patch channels/${CHANNEL}/messages/${MESSAGE}`, `delete channels/${CHANNEL}/messages/${MESSAGE}`]);
    state.list = LOCKED;
    await expect(invoke('edit', edit)).rejects.toBeInstanceOf(PostingLocked);
    // An unlocking plugin that failed to start doesn't unlock.
    state.list = [info('unlocker', 'error')];
    await expect(phone.call('discord', 'send', [ref])).rejects.toBeInstanceOf(PostingLocked);
    expect(api.sent).toHaveLength(2);
  });

  it('a call accepted while unlocked is not sent once posting locks before its attempt goes', async () => {
    const { state, api, invoke } = setup((s) => void (s.list = LOCKED));
    state.list = UNLOCKED;
    await expect(invoke('edit', { ...ref, text: 'fixed' })).rejects.toBeInstanceOf(PostingLocked);
    expect(api.sent).toEqual([]);
  });
});

describe('plugins’ ctx.discord writes', () => {
  const writerPlugin = BUNDLED_PLUGINS.find((p) => p.manifest.id === 'writer')!;
  function writer() {
    const state = { list: LOCKED };
    const prompt = owner();
    const ctx = pluginDiscord(writerPlugin as { manifest: typeof writerPlugin.manifest; discord: { write: true } }, { paced: owner(), prompt, humanPause: async () => undefined, posting: postingGate(async () => state.list), spacer: new ActionSpacer(async () => 0) });
    return { state, prompt, ctx };
  }

  it('refused while locked, sendMessage included; reactions and acks go', async () => {
    const { prompt, ctx } = writer();
    await expect(ctx.post(`channels/${CHANNEL}/messages`, { content: 'hi' })).rejects.toBeInstanceOf(PostingLocked);
    await expect(sendMessage(ctx, CHANNEL, { content: 'hi', allowedMentions: { parse: [], replied_user: false } })).rejects.toBeInstanceOf(PostingLocked);
    await expect(ctx.patch(`channels/${CHANNEL}/messages/${MESSAGE}`, {})).rejects.toBeInstanceOf(PostingLocked);
    await expect(ctx.upload('https://uploads.example/x', Buffer.from('x'))).rejects.toBeInstanceOf(PostingLocked);
    await ctx.put(REACTION);
    await ctx.delete(REACTION);
    await ctx.post(ACK, { token: null });
    expect(prompt.sent).toEqual([`put ${REACTION}`, `delete ${REACTION}`, `post ${ACK}`]);
  });

  it('allowed once an unlocking fixture plugin is on', async () => {
    const { state, prompt, ctx } = writer();
    state.list = UNLOCKED;
    await sendMessage(ctx, CHANNEL, { content: 'hi', allowedMentions: { parse: [], replied_user: false } });
    expect(prompt.sent).toEqual([`post channels/${CHANNEL}/messages`]);
  });

  it('exempts only the owner’s own reaction and acks, never a path that leaves them', () => {
    expect(exemptWrite('put', REACTION)).toBe(true);
    expect(exemptWrite('delete', REACTION)).toBe(true);
    expect(exemptWrite('post', ACK)).toBe(true);
    expect(exemptWrite('post', REACTION)).toBe(false);
    expect(exemptWrite('delete', `channels/${CHANNEL}/messages/${MESSAGE}/reactions/x/300000000000000003`)).toBe(false);
    expect(exemptWrite('put', `channels/${CHANNEL}/messages/${MESSAGE}/reactions/../@me`)).toBe(false);
    expect(exemptWrite('put', `channels/${CHANNEL}/messages/${MESSAGE}/reactions/a\\..\\..\\b/@me`)).toBe(false);
    expect(exemptWrite('delete', `channels/${CHANNEL}/messages/${MESSAGE}`)).toBe(false);
  });
});

describe('PostingLocked over transports', () => {
  it('is restored from the plain error IPC and the phone’s HTTP carry', async () => {
    const message = new PostingLocked().message;
    for (const carried of [new Error(`Error invoking remote method 'discord:send': Error: ${message}`), new Error(message)]) {
      expect(isPostingLocked(carried)).toBe(true);
      await expect(keepPostingLocked(Promise.reject(carried))).rejects.toBeInstanceOf(PostingLocked);
    }
    const other = new Error('Discord 403');
    await expect(keepPostingLocked(Promise.reject(other))).rejects.toBe(other);
  });
});
