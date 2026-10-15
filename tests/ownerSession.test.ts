// Owner writes go only as the account they were asked as: bound when asked (or queued), checked just before headers are attached.
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { DM, SELF as A, dmArchive, friends } from './dmFixtures';
import { discordPage, fakeDiscordSession } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { HeaderCapture } = await import('../src/main/discord/capture');
const { DiscordApi } = await import('../src/main/discord/api');
const { AccountChangedError, OwnerSession, STILL_LOADING, requireWrittenAs } = await import('../src/main/discord/ownerSession');
const { postingClient } = await import('../src/main/plugins/posting');
const { sendOwnerMessage } = await import('../src/main/discord/send');
const { DmService } = await import('../src/main/discord/dms');

const B = '900000000000000002';
const TOKEN: Record<string, string> = { [A]: 'FAKE-account-A', [B]: 'FAKE-account-B' };
const CHANNEL = '200000000000000001';
const NONCE = '1300000000000000001';
/** Gateway opcodes the client sends. */
const IDENTIFY_OP = 2;
const RESUME_OP = 6;
const UPLOAD_URL = 'https://discord-attachments-uploads-prd.storage.googleapis.com/slot';
const unlocked = { unlocked: async () => true };
/** Lets queued promise work run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

function harness() {
  const { session, send } = fakeDiscordSession();
  const capture = new HeaderCapture(session);
  const tap = new EventEmitter();
  const owner = new OwnerSession(tap as never, capture);
  /** Discord API requests as sent: the account token each carried. */
  const sent: { auth: string; method: string; path: string }[] = [];
  /** While set, requests to `held.path` wait for it to resolve. */
  const held: { path: string; until: Promise<void> } = { path: '', until: Promise.resolve() };
  const evaluate = async (script: string) => {
    const q = JSON.parse(/const q = (.*);/.exec(script)![1]!) as { method: string; headers: Record<string, string> };
    const url = new URL(JSON.parse(/fetch\(("[^"]*")/.exec(script)![1]!) as string);
    if (url.pathname.endsWith(held.path)) await held.until;
    if (url.href === UPLOAD_URL) return { status: 200, headers: {}, body: '' };
    sent.push({ auth: q.headers['Authorization']!, method: q.method, path: url.pathname });
    const body = url.pathname.endsWith('/attachments') ? { attachments: [{ id: '0', upload_url: UPLOAD_URL, upload_filename: 'up/a.txt' }] } : { id: '1' };
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };
  const api = new DiscordApi(() => discordPage(evaluate) as never, capture, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
  /** Holds requests to `path` until the returned release is called. */
  const hold = (path: string): (() => void) => {
    let release!: () => void;
    held.path = path;
    held.until = new Promise((resolve) => (release = resolve));
    return release;
  };
  /** The client signs `account` in: its requests carry its token, its gateway socket IDENTIFYs with it, and READY names it. */
  const signIn = (account: string, socketId = account): void => {
    send({ Authorization: TOKEN[account]! });
    tap.emit('sent', { op: IDENTIFY_OP, d: { token: TOKEN[account] }, socketId });
    tap.emit('dispatch', { t: 'READY', s: 1, d: { user: { id: account } }, socketId });
  };
  return { tap, owner, api, sent, send, hold, signIn };
}

const message = (extra: Record<string, unknown> = {}) => ({ channelId: CHANNEL, text: 'private draft written as A', replyTo: null, files: [], stickerId: null, gif: null, nonce: NONCE, ...extra });

describe("the signed-in account's session", () => {
  it('is proven only for the credential its gateway session identified with', () => {
    const h = harness();
    expect(h.owner.current()).toBeNull();
    h.signIn(A);
    const a = h.owner.current()!;
    expect(a.account).toBe(A);
    // B's token reaches REST before B's gateway session does: no account is proven for it yet.
    h.send({ Authorization: TOKEN[B]! });
    expect(h.owner.current()).toBeNull();
    h.tap.emit('sent', { op: IDENTIFY_OP, d: { token: TOKEN[B] }, socketId: 'b' });
    expect(h.owner.current()).toBeNull();
    h.tap.emit('dispatch', { t: 'READY', s: 1, d: { user: { id: B } }, socketId: 'b' });
    expect(h.owner.current()).toEqual({ account: B, generation: a.generation + 1 });
    // A resume continues the proven session.
    h.tap.emit('sent', { op: RESUME_OP, d: { token: TOKEN[B] }, socketId: 'b-again' });
    expect(h.owner.current()?.account).toBe(B);
  });
});

describe('a write asked as one account', () => {
  it('is not sent as another that signs in while it waits behind a request in flight', async () => {
    const h = harness();
    h.signIn(A);
    const release = h.hold('/guilds/1');
    const inFlight = h.api.prompt.get('guilds/1');
    const pending = sendOwnerMessage(postingClient(h.api.prompt, unlocked), message());
    await settle();
    h.signIn(B);
    release();
    await inFlight;
    await expect(pending).rejects.toBeInstanceOf(AccountChangedError);
    expect(h.sent.map((r) => r.auth)).toEqual([TOKEN[A]]);
  });

  it('in an owner action, posts none of its steps as another account that signs in during its upload', async () => {
    const h = harness();
    h.signIn(A);
    const release = h.hold('/slot');
    const send = h.owner.actions({ send: async () => sendOwnerMessage(postingClient(h.api.prompt, unlocked), message({ files: [{ name: 'a.txt', bytes: new Uint8Array([1]) }] })) });
    const pending = send.send();
    await settle();
    h.signIn(B);
    release();
    await expect(pending).rejects.toBeInstanceOf(AccountChangedError);
    expect(h.sent.filter((r) => r.auth === TOKEN[B])).toEqual([]);
  });

  it("closes no DM as another account that signs in while the write's posting lock is read", async () => {
    const h = harness();
    const core = dmArchive();
    let ready = A;
    h.signIn(A);
    let reads = 0;
    let unlock!: () => void;
    // The second read is the per-attempt one, after the DM service's own account guard passed.
    const gate = { unlocked: () => (++reads === 1 ? Promise.resolve(true) : new Promise<boolean>((resolve) => (unlock = () => resolve(true)))) };
    const dms = new DmService({ api: postingClient(h.api.prompt, gate), core: { call: core.call } as never, account: () => ready, friends, settingsChanged: () => undefined, diag: () => undefined });
    const close = h.owner.actions({ close: () => dms.close(DM, false) }).close();
    await settle();
    expect(reads).toBe(2);
    h.signIn(B);
    ready = B;
    unlock();
    await expect(close).rejects.toBeInstanceOf(AccountChangedError);
    expect(h.sent).toEqual([]);
  });

  it('is refused unsent in an owner action asked before any account was proven; a read is not', async () => {
    const h = harness();
    h.send({ Authorization: TOKEN[A]! });
    const calls = h.owner.actions({ write: () => h.api.prompt.post('channels/1/typing', undefined), read: () => h.api.prompt.get('users/@me') });
    await expect(calls.write()).rejects.toThrow(STILL_LOADING);
    await expect(calls.read()).resolves.toEqual({ id: '1' });
  });
});

describe('a message the outbox kept', () => {
  it('goes only as the account it was written as', async () => {
    const h = harness();
    const check = h.owner.actions({ as: async (accountId: unknown) => requireWrittenAs(accountId) });
    await expect(check.as(A)).rejects.toThrow(STILL_LOADING);
    h.signIn(A);
    await expect(check.as(A)).resolves.toBeUndefined();
    h.signIn(B);
    await expect(check.as(A)).rejects.toBeInstanceOf(AccountChangedError);
    // Saved before messages named their account.
    await expect(check.as(undefined)).rejects.toBeInstanceOf(AccountChangedError);
    await expect(check.as(B)).resolves.toBeUndefined();
  });
});
