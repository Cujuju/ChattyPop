// A message with files goes in phases: prepared, uploaded in pieces (progress shown), then posted with the uploads'
// tokens and its nonce. A failure before the post retries any time; uploads the desktop let go are uploaded again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_GONE, type OwnerMessage } from '@shared/compose';
import { isPostingLocked } from '@shared/posting';
import { NONCE_DEDUPE_MS, createOutbox, type OutboxRecord } from '../src/renderer/src/state/outboxQueue';

const CHANNEL = '100000000000000001';
class Unreachable extends Error {}

function setup() {
  const posted: OwnerMessage[] = [];
  const uploads: { files: string[]; progress: (p: number) => void; resolve(t: string[]): void; reject(e: Error): void }[] = [];
  let sendError: Error | null = null;
  let saved: OutboxRecord<string>[] = [];
  const box = createOutbox<string>({
    unlocked: () => true,
    locked: isPostingLocked,
    send: async (m) => {
      if (sendError) {
        const err = sendError;
        sendError = null;
        throw err;
      }
      posted.push(m);
    },
    prepare: async (_c, files) => files,
    upload: (_c, files, progress) => new Promise((resolve, reject) => void uploads.push({ files: files.map((f) => f.name), progress, resolve, reject })),
    uploadGone: (err) => (err as Error).message === UPLOAD_GONE,
    errorText: (err) => (err as Error).message,
    unreachable: (err) => err instanceof Unreachable,
    restore: () => false,
    save: (records) => void (saved = records),
    now: () => Date.now(),
  });
  const file = new File(['clip'], 'clip.mp4', { type: 'video/mp4' });
  box.enqueue({ channelId: CHANNEL, label: 'clip', message: { channelId: CHANNEL, text: 'look', replyTo: null, files: [], stickerId: null, gif: null, nonce: 'n1' }, files: [file], draft: null });
  const head = () => box.outgoing(CHANNEL)[0];
  return { box, posted, uploads, head, saved: () => saved, failNextSend: (e: Error) => void (sendError = e) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('outbox uploads', () => {
  it('shows upload progress, then posts the uploads by token with its nonce; the files are saved by reference', async () => {
    const { posted, uploads, head, saved } = setup();
    await settle();
    expect(head()).toMatchObject({ status: 'sending', phase: 'uploading', text: 'look' });
    expect(saved()[0]!.files[0]!.name).toBe('clip.mp4');
    uploads[0]!.progress(0.5);
    expect(head()!.progress).toBe(0.5);
    uploads[0]!.resolve(['t1']);
    await settle();
    expect(posted).toEqual([expect.objectContaining({ nonce: 'n1', uploads: ['t1'] })]);
    expect(head()).toBeUndefined();
  });

  it('an unreachable desktop mid-upload retries by itself even past the nonce window: nothing was posted', async () => {
    const { box, uploads, head } = setup();
    await settle();
    uploads[0]!.reject(new Unreachable('gone'));
    await settle();
    expect(head()).toMatchObject({ status: 'failed', phase: null });
    vi.setSystemTime(Date.now() + NONCE_DEDUPE_MS);
    box.retryUnreachable();
    await settle();
    expect(uploads).toHaveLength(2);
    expect(head()!.status).toBe('sending');
  });

  it('reuses finished uploads on a retry, and uploads again only when the desktop let them go', async () => {
    const { box, posted, uploads, head, failNextSend } = setup();
    await settle();
    failNextSend(new Error('Discord is down'));
    uploads[0]!.resolve(['t1']);
    await settle();
    expect(head()).toMatchObject({ status: 'failed', error: 'Discord is down' });
    failNextSend(new Error(UPLOAD_GONE));
    box.retrySend(CHANNEL, head()!.id);
    await settle();
    expect(uploads).toHaveLength(2);
    uploads[1]!.resolve(['t2']);
    await settle();
    expect(posted).toEqual([expect.objectContaining({ nonce: 'n1', uploads: ['t2'] })]);
  });

  it('a fresh upload the desktop says is gone fails instead of looping', async () => {
    const { uploads, head, failNextSend } = setup();
    await settle();
    failNextSend(new Error(UPLOAD_GONE));
    uploads[0]!.resolve(['t1']);
    await settle();
    expect(uploads).toHaveLength(1);
    expect(head()).toMatchObject({ status: 'failed', error: UPLOAD_GONE });
  });
});
