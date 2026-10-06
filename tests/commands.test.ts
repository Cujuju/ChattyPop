import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { OPTION, commandEntries, type AppCommand, type CommandRun } from '@shared/commands';
import { COMPONENT, MESSAGE_FLAG, componentsFrom, modalFieldsFrom, modalSubmission } from '@shared/components';
import { OwnerAccount } from '../src/main/discord/account';
import type { DiscordApi } from '../src/main/discord/api';
import { CommandIndexes } from '../src/main/discord/commandIndex';
import type { GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import { Interactions } from '../src/main/discord/interactions';
import { createThread, sendDirect } from '../src/main/discord/send';
import { messagePage } from '../src/core/queries/messages';
import { ownCommands } from '../src/core/queries/ownCommands';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CHANNEL = '200000000000000001';
const GUILD = '100000000000000001';
const APP = '500000000000000001';
const COMMAND = '600000000000000001';
const VERSION = '600000000000000002';
const MESSAGE = '300000000000000001';
const THREAD = '800000000000000001';
const DM = '900000000000000001';
const USER = '110000000000000001';

function fakeTap() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const send = (t: string, d: unknown): boolean => tap.emit('dispatch', { t, s: null, d });
  return { tap: tap as unknown as GatewayTap, send };
}

/** Records DiscordApi POSTs; onInteraction supplies gateway responses for posted interactions. */
function fakeApi(onInteraction: (body: Record<string, unknown>) => void = () => {}) {
  const posts: [string, Record<string, unknown>][] = [];
  const gets: string[] = [];
  let index: (path: string) => unknown = () => ({});
  const api = {
    post: async (path: string, body: Record<string, unknown>) => {
      posts.push([path, body]);
      if (path.endsWith('/attachments')) {
        const files = body['files'] as { id: string; filename: string }[];
        return { attachments: files.map((f) => ({ id: f.id, upload_url: `https://upload/${f.filename}`, upload_filename: `up/${f.filename}` })) };
      }
      if (path === 'interactions') queueMicrotask(() => onInteraction(body));
      if (path.endsWith('/threads')) return { id: THREAD };
      return { id: 'm' + posts.length };
    },
    postOnce: async (path: string, body: Record<string, unknown>) => api.post(path, body),
    upload: async () => {},
    get: async (path: string) => {
      gets.push(path);
      return index(path);
    },
  } as unknown as DiscordApi;
  return { api, posts, gets, answerIndex: (f: (path: string) => unknown) => (index = f) };
}

function setup(onInteraction: (body: Record<string, unknown>, send: (t: string, d: unknown) => boolean) => void) {
  const { tap, send } = fakeTap();
  const account = new OwnerAccount(tap);
  send('READY', { user: { id: 'me' }, session_id: 'sess-1' });
  const fake = fakeApi((b) => onInteraction(b, send));
  return { interactions: new Interactions(tap, fake.api, account), ...fake, send };
}

const run = (r: Partial<CommandRun> = {}): CommandRun => ({
  channelId: CHANNEL,
  guildId: GUILD,
  command: { id: COMMAND, applicationId: APP, version: VERSION, name: 'dice' },
  path: [],
  values: [],
  files: [],
  ...r,
});

describe('slash commands', () => {
  it('lists subcommands in place of their parent, as Discord does', () => {
    const opt = (type: number, name: string, options: AppCommand['options'] = []) => ({
      type,
      name,
      description: name,
      required: false,
      choices: [],
      autocomplete: false,
      options,
      channelTypes: [],
      minValue: null,
      maxValue: null,
      minLength: null,
      maxLength: null,
    });
    const cmd: AppCommand = {
      id: COMMAND,
      applicationId: APP,
      version: VERSION,
      name: 'music',
      description: 'Music',
      options: [opt(OPTION.subcommand, 'play', [opt(OPTION.string, 'song')]), opt(OPTION.group, 'queue', [opt(OPTION.subcommand, 'clear')])],
    };
    expect(commandEntries([cmd]).map((e) => [e.fullName, e.path, e.options.map((o) => o.name)])).toEqual([
      ['music play', ['play'], ['song']],
      ['music queue clear', ['queue', 'clear'], []],
    ]);
  });

  it('runs a command nested under its subcommand, on the client session, and settles when the app acknowledges it', async () => {
    const { interactions, posts } = setup((b, send) => send('INTERACTION_SUCCESS', { id: '1', nonce: b['nonce'] }));
    const outcome = await interactions.runCommand(run({ path: ['roll'], values: [{ name: 'sides', type: OPTION.integer, value: 20 }] }));
    expect(outcome).toEqual({ kind: 'done' });
    const [path, body] = posts[0]!;
    expect(path).toBe('interactions');
    expect(body).toMatchObject({
      type: 2,
      application_id: APP,
      guild_id: GUILD,
      channel_id: CHANNEL,
      session_id: 'sess-1',
      data: { id: COMMAND, version: VERSION, name: 'dice', type: 1, options: [{ type: OPTION.subcommand, name: 'roll', options: [{ type: OPTION.integer, name: 'sides', value: 20 }] }] },
    });
  });

  it('uploads attachment options first; the option names its file by index', async () => {
    const { interactions, posts } = setup((b, send) => send('INTERACTION_SUCCESS', { nonce: b['nonce'] }));
    await interactions.runCommand(run({ files: [{ name: 'image', file: { name: 'a.png', bytes: new Uint8Array(3) } }] }));
    expect(posts.map(([p]) => p)).toEqual([`channels/${CHANNEL}/attachments`, 'interactions']);
    expect(posts[1]![1]['data']).toMatchObject({
      options: [{ type: OPTION.attachment, name: 'image', value: 0 }],
      attachments: [{ id: '0', filename: 'a.png', uploaded_filename: 'up/a.png' }],
    });
  });

  it("returns the app's form when it opens one, and sends the answers nested as the form was", async () => {
    const components = [
      { type: COMPONENT.row, components: [{ type: COMPONENT.textInput, custom_id: 'why', label: 'Why?', style: 2 }] },
      { type: COMPONENT.label, label: 'Pick', component: { type: COMPONENT.stringSelect, custom_id: 'pick', options: [{ label: 'A', value: 'a' }] } },
    ];
    const { interactions, posts } = setup((b, send) =>
      b['type'] === 5
        ? send('INTERACTION_SUCCESS', { nonce: b['nonce'] })
        : send('INTERACTION_MODAL_CREATE', { id: '700000000000000001', nonce: b['nonce'], channel_id: CHANNEL, custom_id: 'form', title: 'Report', components, application: { id: APP, name: 'Bot' } }),
    );
    const outcome = await interactions.runCommand(run());
    if (outcome.kind !== 'modal') throw new Error('expected a form');
    expect(outcome.modal).toMatchObject({ title: 'Report', appName: 'Bot', guildId: GUILD, fields: [{ kind: 'text', paragraph: true, label: 'Why?' }, { kind: 'select', label: 'Pick' }] });
    await interactions.submitModal({ modal: outcome.modal, values: { why: 'spam', pick: ['a'] } });
    expect(posts[1]![1]).toMatchObject({
      type: 5,
      data: {
        id: '700000000000000001',
        custom_id: 'form',
        components: [
          { type: COMPONENT.row, components: [{ type: COMPONENT.textInput, custom_id: 'why', value: 'spam' }] },
          { type: COMPONENT.label, component: { type: COMPONENT.stringSelect, custom_id: 'pick', values: ['a'] } },
        ],
      },
    });
  });

  it("returns the app's suggestions for the focused option", async () => {
    const { interactions, posts } = setup((b, send) => send('APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE', { nonce: b['nonce'], choices: [{ name: 'Paris', value: 'paris' }] }));
    const choices = await interactions.autocomplete({ ...run(), focused: { name: 'city', type: OPTION.string, value: 'Par' } });
    expect(choices).toEqual([{ name: 'Paris', value: 'paris' }]);
    expect(posts[0]![1]).toMatchObject({ type: 4, data: { options: [{ name: 'city', value: 'Par', focused: true }] } });
  });

  it('rejects when the app reports failure', async () => {
    const { interactions } = setup((b, send) => send('INTERACTION_FAILURE', { nonce: b['nonce'] }));
    await expect(interactions.runCommand(run())).rejects.toThrow('did not respond');
  });

  it('presses a button with the message and its flags', async () => {
    const { interactions, posts } = setup((b, send) => send('INTERACTION_SUCCESS', { nonce: b['nonce'] }));
    await interactions.useComponent({ channelId: CHANNEL, guildId: null, messageId: MESSAGE, messageFlags: MESSAGE_FLAG.ephemeral, applicationId: APP, componentType: COMPONENT.button, customId: 'ok' });
    expect(posts[0]![1]).toMatchObject({ type: 3, message_id: MESSAGE, message_flags: MESSAGE_FLAG.ephemeral, data: { component_type: COMPONENT.button, custom_id: 'ok' } });
    expect(posts[0]![1]).not.toHaveProperty('guild_id');
  });

  it("merges the server's commands with the owner's own apps allowed there, and refetches after Discord says the server's changed", async () => {
    const { tap, send } = fakeTap();
    const { api, gets, answerIndex } = fakeApi();
    const command = (id: string, name: string, contexts?: number[]) => ({ id, application_id: APP, version: VERSION, type: 1, name, description: '', contexts });
    answerIndex((path) =>
      path.startsWith('guilds/')
        ? { applications: [{ id: APP, name: 'Bot' }], application_commands: [command('1', 'zeta'), { ...command('9', 'user-menu'), type: 2 }] }
        : { applications: [], application_commands: [command('2', 'alpha', [0]), command('3', 'dm-only', [1, 2])] },
    );
    const indexes = new CommandIndexes(tap);
    const index = await indexes.forChannel(api, CHANNEL, GUILD);
    expect(index.commands.map((c) => c.name)).toEqual(['alpha', 'zeta']);
    await indexes.forChannel(api, CHANNEL, GUILD);
    expect(gets).toHaveLength(2); // cached
    send('GUILD_APPLICATION_COMMAND_INDEX_UPDATE', { guild_id: GUILD });
    await indexes.forChannel(api, CHANNEL, GUILD);
    expect(gets.filter((g) => g.startsWith('guilds/'))).toHaveLength(2);
  });
});

describe('bot messages in the archive', () => {
  it("reads buttons, menus and layout blocks; unknown kinds are left out", () => {
    const parsed = componentsFrom([
      { type: COMPONENT.row, components: [{ type: COMPONENT.button, style: 1, label: 'Go', custom_id: 'go' }, { type: 99 }] },
      { type: COMPONENT.container, accent_color: 0xff0000, components: [{ type: COMPONENT.textDisplay, content: '**hi**' }] },
      { type: COMPONENT.userSelect, custom_id: 'who', max_values: 2 },
    ]);
    expect(parsed).toEqual([
      { type: 'row', children: [{ type: 'button', style: 1, label: 'Go', emoji: null, customId: 'go', url: null, disabled: false }] },
      { type: 'container', color: 0xff0000, children: [{ type: 'text', content: '**hi**' }] },
      expect.objectContaining({ type: 'select', kind: 'user', customId: 'who', maxValues: 2 }),
    ]);
  });

  it('round-trips a form: fields read from the app, answers nested back', () => {
    const fields = modalFieldsFrom([{ type: COMPONENT.row, components: [{ type: COMPONENT.textInput, custom_id: 'a', label: 'A' }] }]);
    expect(modalSubmission(fields, { a: 'x' })).toEqual([{ type: COMPONENT.row, components: [{ type: COMPONENT.textInput, custom_id: 'a', value: 'x' }] }]);
  });

  it("keeps an ephemeral reply when a re-sync doesn't find it (Discord never lists them), and shows who ran what", () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: CHANNEL }]);
    const now = Date.now();
    const bot = { id: APP, username: 'bot', bot: true };
    const reply = rawMessage(CHANNEL, now, 'rolled 7', {
      author: bot,
      flags: MESSAGE_FLAG.ephemeral,
      application_id: APP,
      interaction_metadata: { id: '1', type: 2, name: 'dice roll', user: { id: 'me', username: 'me', global_name: 'Me' } },
      components: [{ type: COMPONENT.row, components: [{ type: COMPONENT.button, style: 2, label: 'Again', custom_id: 'again' }] }],
    });
    const plain = rawMessage(CHANNEL, now + 1, 'hello');
    archive.ingestMessages([reply, plain], ARRIVAL.gateway);
    expect(archive.reconcileDeletes(CHANNEL, [], now - 1, now + 2, now + 3)).toBe(1); // only the plain one
    const [shown] = messagePage(db, { channelId: CHANNEL, limit: 10 });
    expect(shown).toMatchObject({ flags: MESSAGE_FLAG.ephemeral, applicationId: APP, deletedAt: null, interaction: { userName: 'Me', command: 'dice roll' } });
    expect(shown!.components).toHaveLength(1);
  });

  it("counts the owner's commands from apps' replies, most used first, ignoring other people's", () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: CHANNEL }]);
    const t = Date.now();
    const bot = { id: APP, username: 'bot', bot: true };
    const ran = (ms: number, name: string, userId: string, legacy = false) =>
      rawMessage(CHANNEL, ms, 'ok', { author: bot, [legacy ? 'interaction' : 'interaction_metadata']: { id: String(ms), type: 2, name, user: { id: userId, username: userId } } });
    archive.ingestMessages([ran(t, 'roll', 'me'), ran(t + 1, 'fun 8_ball', 'me', true), ran(t + 2, 'fun 8_ball', 'me'), ran(t + 3, 'ban', 'other')], ARRIVAL.gateway);
    expect(ownCommands(db, 'me', 5)).toEqual([
      { applicationId: APP, name: 'fun 8_ball' },
      { applicationId: APP, name: 'roll' },
    ]);
  });
});

describe("Discord's /thread and /msg", () => {
  it('starts a public thread, then posts its first message inside it; with no message, only the thread', async () => {
    const { api, posts } = fakeApi();
    await createThread(api, { channelId: CHANNEL, name: ' plans ', message: 'first!' });
    expect(posts.map(([p]) => p)).toEqual([`channels/${CHANNEL}/threads`, `channels/${THREAD}/messages`]);
    expect(posts[0]![1]).toEqual({ name: 'plans', type: 11 });
    expect(posts[1]![1]).toMatchObject({ content: 'first!', enforce_nonce: true });
    posts.length = 0;
    await createThread(api, { channelId: CHANNEL, name: 'quiet', message: '' });
    expect(posts).toHaveLength(1);
    await expect(createThread(api, { channelId: CHANNEL, name: '  ', message: '' })).rejects.toThrow('Name the thread.');
  });

  it('takes the DM with the person from the DM service, then sends the message there', async () => {
    const { api, posts } = fakeApi();
    const asked: string[] = [];
    const dmWith = async (userId: string): Promise<string> => (asked.push(userId), DM);
    await sendDirect(api, dmWith, { userId: USER, message: 'hey' });
    expect(asked).toEqual([USER]);
    expect(posts.map(([p]) => p)).toEqual([`channels/${DM}/messages`]);
    await expect(sendDirect(api, dmWith, { userId: USER, message: ' ' })).rejects.toThrow('Write a message first.');
  });
});
