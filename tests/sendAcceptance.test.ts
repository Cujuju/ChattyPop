import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputed } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { OwnerMessage, PostedOwnerMessage } from '@shared/compose';
import { postedArchiveMessage } from '@shared/postedMessage';
import { createSentRows } from '../src/renderer/src/state/outboxSent';
import { createOutbox, SEND_BASE_TIMEOUT_MS } from '../src/renderer/src/state/outboxQueue';
import { sendOwnerMessage } from '../src/main/discord/send';
import type { DiscordWriter } from '../src/main/discord/client';
import { acceptedMessage, ACCEPTED_ID, ACCEPTED_AT } from './postedMessageFixture';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const CHANNEL = '200000000000000001';
const NONCE = '1300000000000000000';
const message: OwnerMessage = { channelId: CHANNEL, text: 'accepted', nonce: NONCE, files: [], replyTo: null, stickerId: null, gif: null };
const accepted = () => acceptedMessage(message);
const archived = (): ArchiveMessage => ({ ...postedArchiveMessage(accepted().message, NONCE), content: 'gateway copy' });
const settle = () => vi.advanceTimersByTimeAsync(0);

function setup() {
  const sent = createSentRows();
  const replies: { resolve(m: PostedOwnerMessage): void; reject(e: Error): void }[] = [];
  const box = createOutbox({
    send: () => new Promise<PostedOwnerMessage>((resolve, reject) => replies.push({ resolve, reject })),
    accept: sent.accept, prepare: async (_c, files) => files, upload: async () => [],
    uploadGone: () => false, windowPassed: () => false, errorText: (e) => (e as Error).message,
    unreachable: () => false, restore: () => false, save: () => {}, now: Date.now,
    unlocked: () => true, locked: () => false,
  });
  const enqueue = () => box.enqueue({ channelId: CHANNEL, label: message.text, message, files: [], mentions: {}, draft: null });
  const visible = (rows: ArchiveMessage[] = []) => [
    ...sent.merge(CHANNEL, rows).map((m) => m.id),
    ...box.outgoing(CHANNEL).filter((m) => !sent.hasArchived(m.nonce)).map(() => 'pending'),
  ];
  return { sent, box, replies, enqueue, visible };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('accepted sends', () => {
  it('returns Discord’s full posted payload and the enforced nonce', async () => {
    const posted = accepted().message;
    const post = vi.fn(async (_path: string, _body: unknown) => posted);
    const result = await sendOwnerMessage({ post } as unknown as DiscordWriter, message);
    expect(result).toEqual({ nonce: NONCE, message: posted });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(`channels/${CHANNEL}/messages`);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ nonce: NONCE, enforce_nonce: true });
    const row = postedArchiveMessage(result.message, result.nonce);
    expect(row).toMatchObject({ id: ACCEPTED_ID, ts: ACCEPTED_AT, content: message.text });
  });

  it('publishes acceptance and removes pending atomically, retaining it across stale reads', async () => {
    const s = setup();
    s.enqueue();
    await settle();
    const frames: string[][] = [];
    createComputed(() => frames.push(s.visible()));
    s.replies[0]!.resolve(accepted());
    await settle();
    expect(s.visible()).toEqual([ACCEPTED_ID]);
    expect(frames.every((frame) => frame.length === 1)).toBe(true);
    s.sent.reconcile([]);
    expect(s.visible()).toEqual([ACCEPTED_ID]);
    const gateway = archived();
    expect(s.sent.merge(CHANNEL, [gateway])).toEqual([gateway]);
    s.sent.reconcile([gateway]);
    expect(s.visible([gateway])).toEqual([ACCEPTED_ID]);
    expect(s.sent.merge(CHANNEL, [])).toEqual([]);
  });

  it('dedupes when the gateway arrives before the RPC, by nonce and by id', async () => {
    const s = setup();
    s.enqueue();
    await settle();
    const gateway = archived();
    s.sent.reconcile([gateway]);
    expect(s.visible([gateway])).toEqual([ACCEPTED_ID]);
    s.replies[0]!.resolve(accepted());
    await settle();
    expect(s.visible([gateway])).toEqual([ACCEPTED_ID]);
    expect(s.sent.merge(CHANNEL, [])).toEqual([]);
    s.sent.reconcile([{ ...gateway, nonce: undefined }]);
    s.sent.accept(accepted());
    expect(s.sent.merge(CHANNEL, [])).toEqual([]);
  });

  it('keeps a failed row retryable with the same nonce and adopts the retry', async () => {
    const s = setup();
    s.enqueue();
    await settle();
    s.replies[0]!.reject(new Error('Discord refused it'));
    await settle();
    const head = s.box.outgoing(CHANNEL)[0]!;
    expect(head).toMatchObject({ status: 'failed', retryable: true, nonce: NONCE });
    expect(s.visible()).toEqual(['pending']);
    s.box.retrySend(CHANNEL, head.id);
    await settle();
    s.replies[1]!.resolve(accepted());
    await settle();
    expect(s.visible()).toEqual([ACCEPTED_ID]);
  });

  it('adopts a response that arrives after timeout without another send or duplicate', async () => {
    const s = setup();
    s.enqueue();
    await settle();
    await vi.advanceTimersByTimeAsync(SEND_BASE_TIMEOUT_MS);
    expect(s.box.outgoing(CHANNEL)[0]?.status).toBe('failed');
    s.replies[0]!.resolve(accepted());
    await settle();
    expect(s.visible()).toEqual([ACCEPTED_ID]);
    expect(s.replies).toHaveLength(1);
  });

  it('keeps accepted rows out of another channel and merges them in chronological order', () => {
    const s = createSentRows();
    s.accept(accepted());
    s.accept(accepted());
    const older = { ...archived(), id: 'older', nonce: undefined, ts: ACCEPTED_AT - 1 };
    expect(s.merge(CHANNEL, [older]).map((m) => m.id)).toEqual(['older', ACCEPTED_ID]);
    expect(s.merge('another-channel', [])).toEqual([]);
  });
});
