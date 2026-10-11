// Mobile scheduling crosses the wire, phone allowlist, shared IPC handlers, and the host's existing posting gate.
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererApi } from '@shared/contract';
import { MAIN_INVOKE } from '@shared/contract';
import { decodeWire, encodeWire } from '@shared/wire';
import { DesktopUnreachableError, type PhoneCall } from '@shared/phone';
import { PostingLocked } from '@shared/posting';
import { SCHEDULE_UNCONFIRMED, type ScheduledDraft, type ScheduledMessage } from '@shared/scheduledMessages';
import type { DiscordClient, RequestOptions } from '../src/main/discord/client';
import { PhoneHub } from '../src/main/phone/hub';

const CHANNEL = '100000000000000001';
const USER = '200000000000000002';
const ID = '300000000000000003';
const PATH = 'users/@me/scheduled-messages';
const env = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>() }));
vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: (channel: string, fn: never) => {
  if (env.handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
  env.handlers.set(channel, fn);
} } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined, redactIds: (s: string) => s }));
// Account rollout is tested in scheduledMessages.test.ts; here an eligible account uses the real scheduled service.
vi.mock('../src/main/discord/scheduledAvailability', () => ({ ScheduledGate: class {
  readonly account = { userId: '200000000000000002', enabled: true, limit: 10 };
} }));
const { registerDiscordHandlers } = await import('../src/main/ipc/discord');
const phoneApiPath = '../src/plugin-sdk/renderer/shell/phoneApi';
const { createPhoneRendererApi } = await import(phoneApiPath) as {
  createPhoneRendererApi(t: { call(call: PhoneCall): Promise<unknown>; listen(): void }): RendererApi;
};
beforeEach(() => env.handlers.clear());

const time = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const draft = (): ScheduledDraft => ({ channelId: CHANNEL, text: '@silent mobile message', files: [], uploads: [], replyTo: null,
  stickerId: null, gif: null, nonce: '400000000000000004', scheduledTimestamp: time() });
const item = (): ScheduledMessage => ({ user_id: USER, scheduled_message_id: ID, send_at_timestamp: time(), state: 0,
  create_args: { channel_id: CHANNEL, content: 'mobile message', flags: 4096, type: 0 } });

function harness() {
  const state = { unlocked: true, items: [item()] };
  const get = vi.fn(async (_path: string, _query?: unknown, opts?: RequestOptions) => { await opts?.guard?.(); return state.items; });
  const postOnce = vi.fn(async (path: string, body: unknown, opts?: RequestOptions) => {
    await opts?.guard?.();
    if (path.endsWith('/send')) { state.items = []; return; }
    const b = body as { content: string; flags: number; scheduled_timestamp: string };
    const created = { ...item(), send_at_timestamp: b.scheduled_timestamp, create_args: { ...item().create_args, content: b.content, flags: b.flags } };
    state.items = [created]; return created;
  });
  const patch = vi.fn(async (_path: string, body: unknown, opts?: RequestOptions) => {
    await opts?.guard?.();
    const b = body as { content?: string; flags?: number; scheduled_timestamp?: string };
    const updated = { ...state.items[0]!, send_at_timestamp: b.scheduled_timestamp ?? state.items[0]!.send_at_timestamp,
      create_args: { ...state.items[0]!.create_args, ...(b.content === undefined ? {} : { content: b.content }), ...(b.flags === undefined ? {} : { flags: b.flags }) } };
    state.items = [updated]; return updated;
  });
  const remove = vi.fn(async (_path: string, opts?: RequestOptions) => { await opts?.guard?.(); state.items = []; });
  const owner = { get, postOnce, patch, delete: remove } as unknown as DiscordClient;
  const core = { on: () => undefined, call: vi.fn(async () => []) };
  const calls = registerDiscordHandlers({
    win: {} as never, core: core as never, sync: {} as never, owner,
    capture: { onInvalidated: () => () => undefined, onCaptured: () => () => undefined } as never,
    emit: () => undefined, discordSession: {} as never,
    discord: { tap: new EventEmitter(), webContents: { debugger: {} }, shownChannel: null } as never,
    emojiIndex: {} as never, readStates: { settingsChanged: () => undefined },
    posting: { unlocked: async () => state.unlocked }, chatSettings: { write: async () => undefined },
    directory: { guildList: () => [], channelsOf: () => [] },
  });
  const hub = new PhoneHub({ core: core as never, discord: () => calls, main: async () => undefined, media: async () => new Response(), active: () => true });
  const transport = vi.fn(async (call: PhoneCall) => {
    const sent = decodeWire(encodeWire(call)) as unknown as PhoneCall;
    const result = await hub.gateway.call(sent.group, sent.method, sent.params);
    return (decodeWire(encodeWire({ result })) as { result: unknown }).result;
  });
  const phone = createPhoneRendererApi({ call: transport, listen: () => undefined });
  return { state, phone, transport, postOnce, patch, remove };
}

describe('scheduled sends through the phone', () => {
  it('reads availability and scheduled messages through the desktop', async () => {
    const { phone } = harness();
    expect(await phone.discord.scheduledAvailability(CHANNEL)).toEqual({ enabled: true, limit: 10 });
    expect(await phone.discord.scheduledMessages()).toEqual([expect.objectContaining({ scheduled_message_id: ID })]);
  });

  it('creates, edits and cancels with the existing REST contract, registering each IPC handler once', async () => {
    const { phone, postOnce, patch, remove } = harness();
    const message = draft();
    expect((await phone.discord.createScheduled(message)).create_args.content).toBe('mobile message');
    expect(postOnce).toHaveBeenCalledExactlyOnceWith(PATH, expect.objectContaining({ channel_id: CHANNEL, content: 'mobile message', flags: 4096, scheduled_timestamp: message.scheduledTimestamp }), expect.anything());
    expect((await phone.discord.updateScheduled({ id: ID, content: 'changed' })).create_args.content).toBe('changed');
    expect(patch).toHaveBeenCalledWith(`${PATH}/${ID}`, { content: 'changed', flags: 0 }, expect.anything());
    await phone.discord.cancelScheduled(ID);
    expect(remove).toHaveBeenCalledWith(`${PATH}/${ID}`, expect.anything());
    expect(await phone.discord.scheduledMessages()).toEqual([]);
    for (const method of ['scheduledAvailability', 'scheduledMessages', 'createScheduled', 'updateScheduled', 'cancelScheduled', 'sendScheduledNow'] as const)
      expect(env.handlers.has(MAIN_INVOKE.discord[method])).toBe(true);
  });

  it('sends a pending scheduled message immediately through the same service', async () => {
    const { phone, postOnce } = harness();
    await phone.discord.sendScheduledNow(ID);
    expect(postOnce).toHaveBeenCalledExactlyOnceWith(`${PATH}/${ID}/send`, undefined, expect.anything());
    expect(await phone.discord.scheduledMessages()).toEqual([]);
  });

  it('refuses every scheduled write while posting is locked, while reads remain available', async () => {
    const { state, phone, postOnce, patch, remove } = harness(); state.unlocked = false;
    expect(await phone.discord.scheduledAvailability(CHANNEL)).toEqual({ enabled: true, limit: 10 });
    expect(await phone.discord.scheduledMessages()).toHaveLength(1);
    for (const promise of [phone.discord.createScheduled(draft()), phone.discord.updateScheduled({ id: ID, content: 'changed' }), phone.discord.cancelScheduled(ID), phone.discord.sendScheduledNow(ID)])
      await expect(promise).rejects.toBeInstanceOf(PostingLocked);
    expect(postOnce).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it('preserves definite validation refusals and never sends them to Discord', async () => {
    const { phone, postOnce } = harness();
    await expect(phone.discord.createScheduled({ ...draft(), scheduledTimestamp: new Date().toISOString() })).rejects.toThrow('Too soon');
    expect(postOnce).not.toHaveBeenCalled();
  });
});

describe('an unanswered mobile scheduled creation', () => {
  it.each([new DesktopUnreachableError(), new TypeError('Response body interrupted'), Object.assign(new Error('Aborted'), { name: 'AbortError' })])('reports uncertainty without retrying for %s', async (error) => {
    const call = vi.fn(async () => { throw error; });
    const phone = createPhoneRendererApi({ call, listen: () => undefined });
    await expect(phone.discord.createScheduled(draft())).rejects.toThrow(SCHEDULE_UNCONFIRMED);
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, { ...item(), create_args: { ...item().create_args, channel_id: 'another-channel' } }])('requires a confirmation for the requested channel', async (result) => {
    const call = vi.fn(async () => result);
    const phone = createPhoneRendererApi({ call, listen: () => undefined });
    await expect(phone.discord.createScheduled(draft())).rejects.toThrow(SCHEDULE_UNCONFIRMED);
    expect(call).toHaveBeenCalledOnce();
  });
});
