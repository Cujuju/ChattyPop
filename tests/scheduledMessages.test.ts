import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordHttpError, snowflakeFromMs } from '@shared/discord';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { SCHEDULE_LIMIT_CODE, SCHEDULE_UNAVAILABLE, SUPPRESS_NOTIFICATIONS, defaultScheduleTime, schedulePresets, scheduleWindowError, scheduledContent, scheduledStateLabel, type ScheduledMessage } from '@shared/scheduledMessages';
import { ScheduledMessages, checkScheduledDraft, checkScheduledUpdate } from '../src/main/discord/scheduledMessages';
import { EventEmitter } from 'node:events';
import { ScheduledGate, assignedLimit, murmur3 } from '../src/main/discord/scheduledAvailability';
import type { GatewayTap } from '../src/main/discord/gatewayTap';
import { postingClient } from '../src/main/plugins/posting';
import type { DiscordClient, RequestOptions, WriteOptions } from '../src/main/discord/client';
import type { Uploads } from '../src/main/discord/uploads';

const NOW = new Date(2026, 9, 7, 8, 55).getTime();
const CHANNEL = '200000000000000001';
const USER = '200000000000000002';
const ID = '200000000000000003';
const iso = (offset = MS_PER_HOUR) => new Date(NOW + offset).toISOString();
const draft = () => ({ channelId: CHANNEL, text: 'hello', files: [], uploads: [], replyTo: null, stickerId: null, gif: null, nonce: snowflakeFromMs(NOW), scheduledTimestamp: iso() });
const item = (): ScheduledMessage => ({ user_id: USER, scheduled_message_id: ID, send_at_timestamp: iso(), state: 0, create_args: { channel_id: CHANNEL, content: 'hello', flags: 0, type: 0 } });
function setup() {
  const api = { get: vi.fn(async (_path: string, _query?: unknown, _opts?: RequestOptions) => [item()]),
    postOnce: vi.fn(async (_path: string, _body: unknown, _opts?: WriteOptions) => item()), post: vi.fn(),
    patch: vi.fn(async (_path: string, _body: unknown, _opts?: WriteOptions) => item()),
    delete: vi.fn(async (_path: string, _opts?: WriteOptions) => {}), upload: vi.fn(async (_url: string, _bytes: Buffer) => {}) };
  const account = vi.fn(() => ({ enabled: true, limit: 25, userId: USER as string | null }));
  const service = new ScheduledMessages(api as unknown as DiscordClient, account);
  return { api, account, service };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('scheduled send times', () => {
  it('accepts exact boundaries and rejects invalid, too soon, and too far times', () => {
    expect(scheduleWindowError(NOW + 10 * MS_PER_MIN)).toBeNull();
    expect(scheduleWindowError(NOW + 8 * MS_PER_DAY)).toBeNull();
    expect(scheduleWindowError(NaN)).toMatch(/valid/);
    expect(scheduleWindowError(NOW + 10 * MS_PER_MIN - 1)).toMatch(/Too soon/);
    expect(scheduleWindowError(NOW + 8 * MS_PER_DAY + 1)).toMatch(/Too far/);
  });
  it('uses the replied message snowflake, not a renderer supplied timestamp', () => {
    const reply = snowflakeFromMs(NOW - 29 * MS_PER_DAY);
    expect(scheduleWindowError(NOW + MS_PER_DAY, NOW, reply)).toBeNull();
    expect(scheduleWindowError(NOW + MS_PER_DAY + 1, NOW, reply)).toMatch(/30 days/);
    expect(() => checkScheduledDraft({ ...draft(), replyTo: { messageId: reply, ping: false }, scheduledTimestamp: iso(2 * MS_PER_DAY) })).toThrow(/30 days/);
  });
  it('moves presets too close to tomorrow, and always chooses next ISO-week Monday', () => {
    const presets = schedulePresets();
    expect(presets.map((p) => p.label)).toEqual(['Tomorrow 9 AM', 'Today 1 PM', 'Next Monday 9 AM']);
    const next = new Date(presets[2]!.timestamp);
    expect([next.getDay(), next.getHours(), next.getDate()]).toEqual([1, 9, 12]);
    const monday = new Date(2026, 9, 12, 7).getTime();
    expect(new Date(schedulePresets(monday)[2]!.timestamp).getDate()).toBe(19);
    for (const p of presets) expect(scheduleWindowError(Date.parse(p.timestamp))).toBeNull();
  });
  it('defaults to a whole local hour at least ten minutes away', () => {
    expect(new Date(defaultScheduleTime()).getHours()).toBe(10);
    expect(new Date(defaultScheduleTime(new Date(2026, 9, 7, 8, 50).getTime())).getHours()).toBe(9);
  });
  it('labels every state and handles new states', () => {
    expect([0, 1, 2, 3, 4, 5].map(scheduledStateLabel)).toEqual(['Scheduled', 'Scheduled messages disabled', 'User not found', 'Scheduling unavailable for this account', 'Channel not found', 'Send failed']);
    expect(scheduledStateLabel(99)).toMatch(/Unknown/);
  });
});

describe('scheduled REST contracts', () => {
  it('strips the silent prefix without touching normal mentions', () => {
    expect(scheduledContent('@silent hello', 2)).toEqual({ content: 'hello', flags: 2 | SUPPRESS_NOTIFICATIONS });
    expect(scheduledContent('hi @silent')).toEqual({ content: 'hi @silent', flags: 0 });
    expect(scheduledContent('@silently hi')).toEqual({ content: '@silently hi', flags: 0 });
  });
  it('posts once with cloud uploads, reply mentions, and stickers; releases uploads only after acceptance', async () => {
    const { api, account } = setup();
    const attachment = { id: '0', filename: 'a.png', uploaded_filename: 'cloud/a.png', description: 'alt text' };
    const held = { take: vi.fn(() => [attachment]), release: vi.fn() };
    const service = new ScheduledMessages(api as unknown as DiscordClient, account, held as unknown as Uploads);
    const reply = snowflakeFromMs(NOW - MS_PER_DAY);
    await service.create({ ...draft(), text: '@silent hello', uploads: ['token'], stickerId: ID, replyTo: { messageId: reply, ping: false } });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.postOnce).toHaveBeenCalledWith('users/@me/scheduled-messages', {
      channel_id: CHANNEL, content: 'hello', flags: SUPPRESS_NOTIFICATIONS, scheduled_timestamp: iso(),
      allowed_mentions: { parse: ['users', 'roles', 'everyone'], replied_user: false }, attachments: [attachment],
      message_reference: { channel_id: CHANNEL, message_id: reply }, sticker_ids: [ID],
    }, { guard: expect.any(Function) });
    expect(held.release).toHaveBeenCalledWith(['token']);
  });
  it('uploads inline files into the same attachment shape', async () => {
    const { api, service } = setup();
    api.post.mockResolvedValue({ attachments: [{ id: '0', upload_url: 'https://upload.invalid/a', upload_filename: 'cloud/a.txt' }] });
    await service.create({ ...draft(), files: [{ name: 'a.txt', bytes: new Uint8Array([1]), description: 'a', spoiler: true }] });
    expect(api.upload).toHaveBeenCalledWith('https://upload.invalid/a', Buffer.from([1]));
    expect(api.postOnce.mock.calls[0]?.[1]).toMatchObject({ attachments: [{ filename: 'SPOILER_a.txt', uploaded_filename: 'cloud/a.txt', description: 'a', id: '0' }] });
  });
  it('checks availability and rechecks the clock and account at request time', async () => {
    const { api, account, service } = setup();
    await service.create(draft());
    const guard = (api.postOnce.mock.calls[0] as unknown as [string, unknown, { guard: () => Promise<void> }])[2].guard;
    vi.setSystemTime(NOW + MS_PER_HOUR);
    await expect(guard()).rejects.toThrow(/Too soon/);
    vi.setSystemTime(NOW);
    account.mockReturnValue({ enabled: true, limit: 25, userId: ID });
    await expect(guard()).rejects.toThrow(/account changed/);
    account.mockReturnValue({ enabled: false, limit: 0, userId: USER });
    await expect(service.create(draft())).rejects.toThrow(SCHEDULE_UNAVAILABLE);
  });
  it('does not retry uncertain creation and turns the verified limit code into a useful message', async () => {
    const { api, service } = setup();
    api.postOnce.mockRejectedValue(new DiscordHttpError('limit', 400, SCHEDULE_LIMIT_CODE));
    await expect(service.create(draft())).rejects.toThrow('limit reached (25)');
    expect(api.postOnce).toHaveBeenCalledTimes(1);
  });
  it('reports uncertainty after an attempted create loses its response', async () => {
    const { api, service } = setup();
    api.postOnce.mockImplementation(async (_p, _b, opts) => { await opts?.guard?.(); throw new DiscordHttpError('lost', 502); });
    await expect(service.create(draft())).rejects.toThrow(/not confirmed/);
    expect(api.postOnce).toHaveBeenCalledTimes(1);
  });
  it('passes a poll payload without requiring text or attachments', async () => {
    const { api, service } = setup();
    await service.create({ ...draft(), text: '', poll: { question: 'Ready?', answers: ['Yes', 'No'], durationHours: 24, multiselect: false } });
    expect(api.postOnce.mock.calls[0]?.[1]).toMatchObject({ content: '', poll: { question: { text: 'Ready?' }, answers: [{ poll_media: { text: 'Yes' } }, { poll_media: { text: 'No' } }] } });
  });
  it('validates ids, content, flags, and time before a write', () => {
    expect(() => checkScheduledDraft({ ...draft(), channelId: '../users' })).toThrow(/id/);
    expect(() => checkScheduledDraft({ ...draft(), text: '@silent ' })).toThrow(/Write/);
    expect(() => checkScheduledDraft({ ...draft(), scheduledTimestamp: 'bad' })).toThrow(/valid/);
    expect(() => checkScheduledUpdate({ id: ID, content: 'x'.repeat(2001) })).toThrow(/text/);
    expect(() => checkScheduledUpdate({ id: ID, flags: -1, content: 'x' })).toThrow(/flags/);
  });
  it('returns GET errors rather than inventing an empty disabled list', async () => {
    const { api, service } = setup();
    api.get.mockRejectedValue(new DiscordHttpError('disabled', 403));
    await expect(service.list()).rejects.toThrow('disabled');
  });
  it('filters other accounts and rejects an account change after GET', async () => {
    const { api, account, service } = setup();
    api.get.mockResolvedValue([{ ...item(), user_id: ID }, item()]);
    expect(await service.list()).toEqual([item()]);
    account.mockReturnValueOnce({ enabled: true, limit: 25, userId: USER }).mockReturnValue({ enabled: true, limit: 25, userId: ID });
    await expect(service.list()).rejects.toThrow(/account changed/);
  });
  it('reschedules using the original reply age and normalizes silent edits', async () => {
    const { api, service } = setup();
    api.get.mockResolvedValue([{ ...item(), create_args: { ...item().create_args, message_reference: { message_id: snowflakeFromMs(NOW - 29 * MS_PER_DAY) } } }]);
    await expect(service.update({ id: ID, scheduledTimestamp: iso(2 * MS_PER_DAY) })).rejects.toThrow(/30 days/);
    await service.update({ id: ID, content: '@silent changed', scheduledTimestamp: iso() });
    expect(api.patch).toHaveBeenCalledWith(`users/@me/scheduled-messages/${ID}`, { content: 'changed', flags: SUPPRESS_NOTIFICATIONS, scheduled_timestamp: iso() }, { guard: expect.any(Function) });
  });
  it('cancels and sends now only at the owner endpoints with single-attempt sends', async () => {
    const { api, service } = setup();
    await service.remove(ID);
    await service.remove(ID, true);
    expect(api.delete).toHaveBeenCalledWith(`users/@me/scheduled-messages/${ID}`, { guard: expect.any(Function) });
    expect(api.postOnce).toHaveBeenCalledWith(`users/@me/scheduled-messages/${ID}/send`, undefined, { guard: expect.any(Function) });
  });
  it('supports a flags-only update without overwriting text', async () => {
    const { api, service } = setup();
    await service.update({ id: ID, flags: SUPPRESS_NOTIFICATIONS });
    expect(api.patch).toHaveBeenCalledWith(`users/@me/scheduled-messages/${ID}`, { flags: SUPPRESS_NOTIFICATIONS }, { guard: expect.any(Function) });
  });
  it('meets the posting lock even for scheduled endpoint writes', async () => {
    const { api, account } = setup();
    const client = postingClient(api as unknown as DiscordClient, { unlocked: async () => false });
    const service = new ScheduledMessages(client, account);
    await expect(service.create(draft())).rejects.toThrow(/Posting is off/);
    await expect(service.remove(ID, true)).rejects.toThrow(/Posting is off/);
    expect(api.postOnce).not.toHaveBeenCalled();
  });
});

describe('scheduled-message availability from the gateway', () => {
  /** The experiment's hash as the live client's stored assignments name it (verified 2026-10-07). */
  const HASH = 1950700659;
  type Apex = Parameters<typeof assignedLimit>[0];
  const apex = (variant: number, flags: number, config?: string): Apex => ({ assignments: { 1: { [USER]: { assignments: [[HASH, variant, flags, 1, variant, config]] } } } });

  it('hashes experiment names as the client does', () => {
    expect(murmur3('2026-08-scheduled-messages')).toBe(HASH);
    expect(murmur3('')).toBe(0);
  });
  it('reads the limit from an enabled assignment and fails closed otherwise', () => {
    expect(assignedLimit(apex(1, 2, '{"limit":1}'), USER)).toBe(1);
    expect(assignedLimit(apex(2, 0, '{"limit":3}'), USER)).toBe(3);
    expect(assignedLimit(apex(0, 0, '{"limit":1}'), USER)).toBe(0);
    expect(assignedLimit(apex(1, 8, '{"limit":1}'), USER)).toBe(0);
    expect(assignedLimit(apex(1, 0, 'not json'), USER)).toBe(0);
    expect(assignedLimit(apex(1, 0), USER)).toBe(0);
    expect(assignedLimit({ assignments: { 1: { [USER]: { assignments: [] } } } }, USER)).toBe(0);
    expect(assignedLimit(apex(1, 0, '{"limit":1}'), ID)).toBeNull();
    expect(assignedLimit(undefined, USER)).toBeNull();
  });
  it('follows READY and STATE_UPDATE for the signed-in account; Nitro gets 25', () => {
    const tap = new EventEmitter();
    const owner = { userId: null as string | null, premiumType: 0 };
    const gate = new ScheduledGate(tap as unknown as GatewayTap, owner);
    expect(gate.account).toEqual({ enabled: false, limit: 0, userId: null });
    owner.userId = USER;
    tap.emit('dispatch', { t: 'READY', d: { user: { id: USER }, apex_experiments: apex(1, 0, '{"limit":1}') } });
    expect(gate.account).toEqual({ enabled: true, limit: 1, userId: USER });
    owner.premiumType = 2;
    expect(gate.account.limit).toBe(25);
    tap.emit('dispatch', { t: 'STATE_UPDATE', d: { apex_experiments: { assignments: {} } } });
    expect(gate.account.enabled).toBe(true);
    tap.emit('dispatch', { t: 'STATE_UPDATE', d: { apex_experiments: apex(0, 0) } });
    expect(gate.account).toEqual({ enabled: false, limit: 0, userId: USER });
  });
});
