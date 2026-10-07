// Main's uploads (discord/uploads.ts): a slot per file within the channel's limit; pieces in order, streamed on;
// a message names only finished uploads in its channel, and they are released once Discord accepts it.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_GONE, uploadLimitBytes } from '@shared/compose';
import { BYTES_PER_GB, BYTES_PER_MB } from '@shared/units';
import { sendOwnerMessage } from '../src/main/discord/send';
import { Uploads } from '../src/main/discord/uploads';

const CHANNEL = '100000000000000001';
const OTHER = '100000000000000002';
const NONCE = '100000000000000009';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

/** Electron's ClientRequest as Uploads drives it: writes acknowledged, the store's answer on end. */
class FakeRequest extends EventEmitter {
  chunkedEncoding = false;
  written: number[] = [];
  aborted = false;
  constructor(private readonly status: number) {
    super();
  }
  write(chunk: Buffer, _enc: undefined, done: () => void): void {
    this.written.push(chunk.length);
    done();
  }
  end(): void {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = this.status;
    this.emit('response', res);
    res.emit('end');
  }
  abort(): void {
    this.aborted = true;
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
