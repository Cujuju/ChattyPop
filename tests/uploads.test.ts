// Main's uploads (discord/uploads.ts): a slot per file within the channel's limit; pieces in order, streamed on;
// a message names only finished uploads in its channel, and they are released once Discord accepts it.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST_WINDOW_PASSED, UPLOAD_GONE, uploadLimitBytes } from '@shared/compose';
import { BYTES_PER_GB, BYTES_PER_MB } from '@shared/units';
import { sendOwnerMessage } from '../src/main/discord/send';
import { UPLOAD_IDLE_MS, Uploads } from '../src/main/discord/uploads';

const CHANNEL = '100000000000000001';
const OTHER = '100000000000000002';
const NONCE = '100000000000000009';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

/** Electron's ClientRequest as Uploads drives it: writes acknowledged (unless `hold`), the store's answer on end. */
class FakeRequest extends EventEmitter {
  static hold = false;
  chunkedEncoding = false;
  written: number[] = [];
  aborted = false;
  constructor(private readonly status: number) {
    super();
  }
  write(chunk: Buffer, _enc: undefined, done: () => void): void {
    this.written.push(chunk.length);
    if (!FakeRequest.hold) done();
  }
  end(): void {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = this.status;
    this.emit('response', res);
    res.emit('end');
  }
  abort(): void {
    this.aborted = true;
    this.emit('abort');
    this.emit('close');
  }
}

const requests: FakeRequest[] = [];
let storeStatus = HTTP_OK;
vi.mock('electron', () => ({ net: { request: () => (requests.push(new FakeRequest(storeStatus)), requests.at(-1)) } }));

function setup(limit = 100) {
  const posts: { path: string; json: Record<string, unknown> }[] = [];
  const api = {
    post: async (path: string, json: Record<string, unknown>) => {
      posts.push({ path, json });
      if (path.endsWith('/attachments')) return { attachments: (json['files'] as { id: string }[]).map((f) => ({ id: f.id, upload_url: `https://upload/${f.id}`, upload_filename: `up/${f.id}` })) };
      return { id: '1' };
    },
  } as never;
  const uploads = new Uploads({} as never, async () => limit);
  return { api, uploads, posts };
}

const message = (uploads: string[]) => ({ channelId: CHANNEL, text: '', replyTo: null, files: [], uploads, stickerId: null, gif: null, nonce: NONCE });

describe('Uploads', () => {
  it('refuses a file over the channel’s limit before asking Discord', async () => {
    const { api, uploads, posts } = setup(10);
    await expect(uploads.prepare(api, CHANNEL, [{ name: 'big.mov', size: 11 }])).rejects.toThrow(/big\.mov is over/);
    expect(posts).toEqual([]);
  });

  it('streams pieces in order, then a message names the finished upload and releases it', async () => {
    const { api, uploads, posts } = setup();
    const [slot] = await uploads.prepare(api, CHANNEL, [{ name: 'clip.mp4', size: 5 }]);
    await expect(uploads.chunk(slot!.token, 2, new Uint8Array(3))).rejects.toThrow(/out of order/);
    await uploads.chunk(slot!.token, 0, new Uint8Array(2));
    await uploads.chunk(slot!.token, 2, new Uint8Array(3));
    expect(requests.at(-1)!.chunkedEncoding).toBe(true);
    expect(requests.at(-1)!.written).toEqual([2, 3]);
    await uploads.finish(slot!.token);
    await sendOwnerMessage(api, message([slot!.token]), uploads);
    expect(posts.at(-1)!.json['attachments']).toEqual([{ id: '0', filename: 'clip.mp4', uploaded_filename: 'up/0' }]);
    expect(posts.at(-1)!.json['nonce']).toBe(NONCE);
    await expect(sendOwnerMessage(api, message([slot!.token]), uploads)).rejects.toThrow(UPLOAD_GONE);
  });

  it('a message can’t name an unfinished upload, or one for another channel', async () => {
    const { api, uploads } = setup();
    const [slot] = await uploads.prepare(api, CHANNEL, [{ name: 'a.png', size: 1 }]);
    expect(() => uploads.take(CHANNEL, [slot!.token])).toThrow(UPLOAD_GONE);
    await uploads.chunk(slot!.token, 0, new Uint8Array(1));
    await uploads.finish(slot!.token);
    expect(() => uploads.take(OTHER, [slot!.token])).toThrow(UPLOAD_GONE);
  });

  it('a refused upload is dropped and says why', async () => {
    storeStatus = HTTP_FORBIDDEN;
    const { api, uploads } = setup();
    const [slot] = await uploads.prepare(api, CHANNEL, [{ name: 'a.png', size: 1 }]);
    await uploads.chunk(slot!.token, 0, new Uint8Array(1));
    await expect(uploads.finish(slot!.token)).rejects.toThrow(/refused the upload \(403\)/);
    await expect(uploads.finish(slot!.token)).rejects.toThrow(UPLOAD_GONE);
    storeStatus = HTTP_OK;
  });
});

describe('Uploads, pieces and idle', () => {
  afterEach(() => {
    FakeRequest.hold = false;
    vi.useRealTimers();
  });

  it('refuses a second piece while one is being sent', async () => {
    const { api, uploads } = setup();
    const [slot] = await uploads.prepare(api, CHANNEL, [{ name: 'a.mp4', size: 4 }]);
    FakeRequest.hold = true;
    const first = uploads.chunk(slot!.token, 0, new Uint8Array(2));
    await expect(uploads.chunk(slot!.token, 0, new Uint8Array(2))).rejects.toThrow(/out of order/);
    await expect(uploads.finish(slot!.token)).rejects.toThrow(/missing pieces/);
    expect(requests.at(-1)!.written).toEqual([2]);
    first.catch(() => undefined);
  });

  it('a finished file stays held while the message’s later files upload', async () => {
    vi.useFakeTimers();
    const { api, uploads } = setup();
    const [a, b] = await uploads.prepare(api, CHANNEL, [
      { name: 'a.png', size: 1 },
      { name: 'b.png', size: 2 },
    ]);
    await uploads.chunk(a!.token, 0, new Uint8Array(1));
    await uploads.finish(a!.token);
    for (const offset of [0, 1]) {
      vi.advanceTimersByTime(UPLOAD_IDLE_MS / 2 + 1);
      await uploads.chunk(b!.token, offset, new Uint8Array(1));
    }
    await uploads.finish(b!.token);
    expect(uploads.take(CHANNEL, [a!.token, b!.token])).toHaveLength(2);
  });

  it('dropping an idle upload fails the piece waiting on it', async () => {
    vi.useFakeTimers();
    const { api, uploads } = setup();
    const [slot] = await uploads.prepare(api, CHANNEL, [{ name: 'a.mp4', size: 4 }]);
    FakeRequest.hold = true;
    const piece = uploads.chunk(slot!.token, 0, new Uint8Array(2));
    vi.advanceTimersByTime(UPLOAD_IDLE_MS);
    await expect(piece).rejects.toThrow(UPLOAD_GONE);
    expect(requests.at(-1)!.aborted).toBe(true);
  });
});

describe('the sender’s post window', () => {
  afterEach(() => vi.useRealTimers());

  it('main starts no post attempt past it, even after waiting in the queue', async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const queueWaitMs = 2000;
    const api = {
      post: async (path: string, _json: unknown, opts?: { guard?: () => void }) => {
        vi.setSystemTime(Date.now() + queueWaitMs);
        opts?.guard?.();
        posts.push(path);
        return { id: '1' };
      },
    } as never;
    await expect(sendOwnerMessage(api, { ...message([]), text: 'hi', postWithinMs: queueWaitMs / 2 })).rejects.toThrow(POST_WINDOW_PASSED);
    await sendOwnerMessage(api, { ...message([]), text: 'hi', postWithinMs: queueWaitMs * 2 });
    expect(posts).toEqual([`channels/${CHANNEL}/messages`]);
  });
});

describe('uploadLimitBytes', () => {
  it('is the plan’s limit or the server’s Boost limit, whichever is larger', () => {
    expect(uploadLimitBytes(0, null)).toBe(10 * BYTES_PER_MB);
    expect(uploadLimitBytes(3, null)).toBe(50 * BYTES_PER_MB);
    expect(uploadLimitBytes(2, 3)).toBe(BYTES_PER_GB);
    expect(uploadLimitBytes(0, 2)).toBe(50 * BYTES_PER_MB);
    expect(uploadLimitBytes(0, 3)).toBe(100 * BYTES_PER_MB);
    expect(uploadLimitBytes(0, 1)).toBe(10 * BYTES_PER_MB);
  });
});
