// Outbox sends serialize per channel. Failures block successors; retries reuse nonces. Queues survive reloads; automatic retries stay within Discord’s nonce-deduplication window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST_WINDOW_PASSED, type OwnerMessage } from '@shared/compose';
import { PostingLocked, isPostingLocked } from '@shared/posting';
import { AUTO_RETRY_MS, NONCE_DEDUPE_MS, SEND_BASE_TIMEOUT_MS, createOutbox, type OutboxJob, type OutboxRecord } from '../src/renderer/src/state/outboxQueue';

const CHANNEL = '100000000000000001';

class Unreachable extends Error {}

interface Pending {
  m: OwnerMessage;
  resolve(): void;
  reject(err: Error): void;
}

function setup(canRestore = false) {
  const pending: Pending[] = [];
  const restored: string[] = [];
  let saved: OutboxRecord<string>[] = [];
  const lock = { unlocked: true };
  const box = createOutbox<string>({
    unlocked: () => lock.unlocked,
    locked: isPostingLocked,
    send: (m) => new Promise<void>((resolve, reject) => void pending.push({ m, resolve, reject })),
    prepare: async (_channelId, files) => files,
    upload: async (_channelId, files) => files.map((f) => `token-${f.name}`),
    uploadGone: () => false,
    windowPassed: (err) => (err as Error).message === POST_WINDOW_PASSED,
    errorText: (err) => (err as Error).message,
    unreachable: (err) => err instanceof Unreachable,
    restore: (_channelId, draft) => canRestore && void restored.push(draft) === undefined,
    save: (records) => void (saved = records),
    now: () => Date.now(),
  });
  const job = (text: string, editable = true): OutboxJob<string> => ({
    channelId: CHANNEL,
    label: text,
    message: { channelId: CHANNEL, text, replyTo: null, files: [], stickerId: null, gif: null, nonce: `n-${text}` },
    files: [],
    draft: editable ? text : null,
  });
  const labels = () => box.outgoing(CHANNEL).map((o) => `${o.label}:${o.status}`);
  const headId = () => box.outgoing(CHANNEL)[0]!.id;
  return { box, pending, job, labels, headId, restored, saved: () => saved, lock };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('outbox', () => {
  it('sends one at a time, in order, keeping what is unsent saved', async () => {
    const { box, pending, job, labels, saved } = setup();
    box.enqueue(job('a'));
    box.enqueue(job('b'));
    await settle();
    expect(pending.map((p) => p.m.text)).toEqual(['a']);
    expect(labels()).toEqual(['a:sending', 'b:queued']);
    expect(saved().map((r) => `${r.label}:${r.status}`)).toEqual(['a:sending', 'b:queued']);
    pending[0]!.resolve();
    await settle();
    expect(pending.map((p) => p.m.text)).toEqual(['a', 'b']);
    pending[1]!.resolve();
    await settle();
    expect(labels()).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it('a refusal holds the rest and never retries by itself; Retry resends with the same nonce', async () => {
    const { box, pending, job, labels, headId } = setup();
    box.enqueue(job('a'));
    box.enqueue(job('b'));
    await settle();
    pending[0]!.reject(new Error('Missing access'));
    await settle();
    expect(labels()).toEqual(['a:failed', 'b:queued']);
    expect(box.outgoing(CHANNEL)[0]!.error).toBe('Missing access');
    box.retryUnreachable();
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_MS);
    expect(pending).toHaveLength(1);
    box.retrySend(CHANNEL, headId());
    await settle();
    expect(pending[1]!.m.nonce).toBe(pending[0]!.m.nonce);
    pending[1]!.resolve();
    await settle();
    expect(pending[2]!.m.text).toBe('b');
  });

  it('Edit puts a failure back only into an empty composer, and only an editable one', async () => {
    const empty = setup(true);
    empty.box.enqueue(empty.job('gif', false));
    empty.box.enqueue(empty.job('a'));
    await settle();
    empty.pending[0]!.reject(new Error('Missing access'));
    await settle();
    expect(empty.box.editSend(CHANNEL, empty.headId())).toBe(false);
    empty.box.discardSend(CHANNEL, empty.headId());
    await settle();
    empty.pending[1]!.reject(new Error('Missing access'));
    await settle();
    expect(empty.box.editSend(CHANNEL, empty.headId())).toBe(true);
    expect(empty.restored).toEqual(['a']);
    expect(empty.labels()).toEqual([]);

    const busy = setup(false);
    busy.box.enqueue(busy.job('a'));
    await settle();
    busy.pending[0]!.reject(new Error('Missing access'));
    await settle();
    expect(busy.box.editSend(CHANNEL, busy.headId())).toBe(false);
    expect(busy.labels()).toEqual(['a:failed']);
  });

  it('a stalled send fails, is dropped if it lands later, and the rest go on', async () => {
    const { box, pending, job, labels } = setup();
    box.enqueue(job('a'));
    box.enqueue(job('b'));
    await settle();
    await vi.advanceTimersByTimeAsync(SEND_BASE_TIMEOUT_MS);
    expect(labels()).toEqual(['a:failed', 'b:queued']);
    pending[0]!.resolve();
    await settle();
    expect(pending.map((p) => p.m.text)).toEqual(['a', 'b']);
    expect(labels()).toEqual(['b:sending']);
  });

  it('Discard drops a failed message and the rest go on; tapping away hides until the next failure', async () => {
    const { box, pending, job, labels, headId } = setup();
    box.enqueue(job('a'));
    box.enqueue(job('b'));
    box.dismissSending(CHANNEL);
    await settle();
    expect(box.sendingDismissed(CHANNEL)).toBe(true);
    pending[0]!.reject(new Error('nope'));
    await settle();
    expect(box.sendingDismissed(CHANNEL)).toBe(false);
    box.discardSend(CHANNEL, headId());
    await settle();
    expect(labels()).toEqual(['b:sending']);
  });

  it('an unreachable desktop retries by itself (on a timer and on reconnect) with the same nonce', async () => {
    const { box, pending, job, labels } = setup();
    box.enqueue(job('a'));
    await settle();
    pending[0]!.reject(new Unreachable('offline'));
    await settle();
    expect(labels()).toEqual(['a:failed']);
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_MS);
    expect(pending).toHaveLength(2);
    pending[1]!.reject(new Unreachable('offline'));
    await settle();
    box.retryUnreachable();
    await settle();
    expect(pending.map((p) => p.m.nonce)).toEqual(['n-a', 'n-a', 'n-a']);
    pending[2]!.resolve();
    await settle();
    expect(labels()).toEqual([]);
  });

  it('while posting is locked nothing is sent: messages wait queued, retries stop, and unlocking sends them', async () => {
    const { box, pending, job, labels, lock } = setup();
    lock.unlocked = false;
    box.enqueue(job('a'));
    await settle();
    expect(pending).toHaveLength(0);
    expect(labels()).toEqual(['a:queued']);
    lock.unlocked = true;
    box.resume();
    await settle();
    // Relocked before main sent it: refused unsent (as IPC carries it), it waits queued again.
    pending[0]!.reject(new Error(`Error invoking remote method 'discord:send': Error: ${new PostingLocked().message}`));
    await settle();
    expect(labels()).toEqual(['a:queued']);
    lock.unlocked = false;
    box.enqueue(job('b'));
    box.resume();
    await settle();
    expect(pending).toHaveLength(1);
    lock.unlocked = true;
    box.resume();
    await settle();
    pending[1]!.reject(new Unreachable('offline'));
    await settle();
    expect(labels()).toEqual(['a:failed', 'b:queued']);
    // Locked again: the automatic retry and a reconnect send nothing until the next unlock.
    lock.unlocked = false;
    box.suspend();
    box.retryUnreachable();
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_MS);
    expect(pending).toHaveLength(2);
    lock.unlocked = true;
    box.resume();
    await settle();
    expect(pending.map((p) => p.m.nonce)).toEqual(['n-a', 'n-a', 'n-a']);
  });

  it('past the nonce dedupe window it stops retrying and asks for a check; Retry still sends', async () => {
    const { box, pending, job, labels, headId } = setup();
    box.enqueue(job('a'));
    await settle();
    await vi.advanceTimersByTimeAsync(NONCE_DEDUPE_MS);
    const sends = pending.length;
    for (const p of pending) p.reject(new Unreachable('offline'));
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_MS);
    expect(pending).toHaveLength(sends);
    expect(labels()).toEqual(['a:failed']);
    expect(box.outgoing(CHANNEL)[0]!.error).toMatch(/Check the channel/);
    box.retrySend(CHANNEL, headId());
    await settle();
    expect(pending).toHaveLength(sends + 1);
  });

  it('reloaded, it sends what was queued; one cut off while sending fails and retries within its window', async () => {
    const before = setup();
    before.box.enqueue(before.job('a'));
    before.box.enqueue(before.job('b'));
    await settle();
    const records = before.saved();
    expect(records.map((r) => r.status)).toEqual(['sending', 'queued']);

    const after = setup();
    after.box.load(records);
    await settle();
    expect(after.labels()).toEqual(['a:sending', 'b:queued']);
    expect(after.pending[0]!.m.nonce).toBe('n-a');
    after.pending[0]!.resolve();
    await settle();
    expect(after.pending[1]!.m.text).toBe('b');
  });

  it('reloaded past the window, one cut off while sending waits for a check instead of resending', async () => {
    const before = setup();
    before.box.enqueue(before.job('a'));
    await settle();
    const records = before.saved();
    vi.setSystemTime(Date.now() + NONCE_DEDUPE_MS);

    const after = setup();
    after.box.load(records);
    await settle();
    expect(after.pending).toHaveLength(0);
    expect(after.labels()).toEqual(['a:failed']);
    expect(after.box.outgoing(CHANNEL)[0]!.error).toMatch(/Check the channel/);
  });

  it('a retry by itself refused by the lock and reloaded past the window waits for a check', async () => {
    const before = setup();
    before.box.enqueue(before.job('a'));
    await settle();
    before.pending[0]!.reject(new Unreachable('gone'));
    await settle();
    before.box.retryUnreachable();
    await settle();
    before.pending[1]!.reject(new PostingLocked());
    await settle();
    expect(before.labels()).toEqual(['a:queued']);
    const records = before.saved();
    vi.setSystemTime(Date.now() + NONCE_DEDUPE_MS);

    const after = setup();
    after.box.load(records);
    await settle();
    expect(after.pending).toHaveLength(0);
    expect(after.box.outgoing(CHANNEL)[0]!.error).toMatch(/Check the channel/);
  });

  it('an unconfirmed post carries the window left; main refusing past it waits for a check; the owner’s Retry has no deadline', async () => {
    const { box, pending, job, headId } = setup();
    box.enqueue(job('a'));
    await settle();
    expect(pending[0]!.m.postWithinMs).toBe(NONCE_DEDUPE_MS);
    pending[0]!.reject(new Error(POST_WINDOW_PASSED));
    await settle();
    expect(box.outgoing(CHANNEL)[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Check the channel/) });
    await vi.advanceTimersByTimeAsync(AUTO_RETRY_MS);
    expect(pending).toHaveLength(1);
    box.retrySend(CHANNEL, headId());
    await settle();
    expect(pending[1]!.m).not.toHaveProperty('postWithinMs');
  });

  it('one whose files weren’t kept fails for good after a reload: Retry would send it without them', async () => {
    const { box, pending, job, headId } = setup();
    const record: OutboxRecord<string> = { ...job('a'), status: 'queued', error: null, firstSentAt: null, unreachable: false, uploads: null, files: [], fileCount: 1 };
    box.load([record]);
    await settle();
    expect(box.outgoing(CHANNEL)[0]).toMatchObject({ status: 'failed', retryable: false, error: expect.stringMatching(/files couldn’t be kept/) });
    box.retrySend(CHANNEL, headId());
    await settle();
    expect(pending).toHaveLength(0);
  });
});
