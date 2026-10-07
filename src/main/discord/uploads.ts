// The owner's uploads to Discord's attachment store, sent on in pieces as the sender reads them, so memory stays bounded
// at any file size. The PUT goes through the embedded client's session without its cookies; slots are Discord's own.
import { randomUUID } from 'node:crypto';
import { net, type ClientRequest, type Session } from 'electron';
import { DISCORD_FILES_PER_MESSAGE_MAX, snowflakeArg } from '@shared/discord';
import { UPLOAD_CHUNK_BYTES, UPLOAD_GONE, type UploadSlot } from '@shared/compose';
import { BYTES_PER_MB, MS_PER_MIN } from '@shared/units';
import type { DiscordWriter } from './client';
import type { UploadedFile } from './send';

/** An upload with no piece for this long is dropped: its sender gave up or went away. */
export const UPLOAD_IDLE_MS = 10 * MS_PER_MIN;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

interface DiscordSlot {
  id: number | string;
  upload_url: string;
  upload_filename: string;
}

interface Upload {
  channelId: string;
  name: string;
  size: number;
  url: string;
  uploadFilename: string;
  sent: number;
  request: ClientRequest | null;
  /** Discord's store answered (its status), or the request failed. */
  answered: Promise<number> | null;
  finished: boolean;
  /** A piece is being sent: pieces go one at a time. */
  writing: boolean;
  /** The message's uploads, this one included: activity on any keeps them all, so earlier files don't expire while later ones go. */
  batch: Set<string>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

const isFileMeta = (f: unknown): f is { name: string; size: number } => {
  const o = f as { name?: unknown; size?: unknown } | null;
  return !!o && typeof o.name === 'string' && o.name.trim() !== '' && Number.isSafeInteger(o.size) && (o.size as number) >= 0;
};

export class Uploads {
  private readonly held = new Map<string, Upload>();

  /** `limit`: the largest file the owner may upload to a channel (uploadLimitBytes). */
  constructor(
    private readonly session: Session,
    private readonly limit: (channelId: string) => Promise<number>,
  ) {}

  /** Asks Discord for a slot per file, as the web client does; throws the reason a file can't go (over the channel's limit). */
  async prepare(api: DiscordWriter, channelIdArg: unknown, filesArg: unknown): Promise<UploadSlot[]> {
    const channelId = snowflakeArg(channelIdArg, 'channel');
    if (!Array.isArray(filesArg) || !filesArg.length || filesArg.length > DISCORD_FILES_PER_MESSAGE_MAX || !filesArg.every(isFileMeta))
      throw new Error(`Attach 1 to ${DISCORD_FILES_PER_MESSAGE_MAX} files.`);
    const limit = await this.limit(channelId);
    const tooBig = filesArg.find((f) => f.size > limit);
    if (tooBig) throw new Error(`${tooBig.name} is over the ${Math.round(limit / BYTES_PER_MB)} MB upload limit here.`);
    const { attachments: slots } = await api.post<{ attachments: DiscordSlot[] }>(`channels/${channelId}/attachments`, {
      files: filesArg.map((f, i) => ({ id: String(i), filename: f.name, file_size: f.size, is_clip: false })),
    });
    const batch = new Set<string>();
    const refs = filesArg.map((f, i) => {
      const slot = slots.find((s) => String(s.id) === String(i));
      if (!slot) throw new Error('Discord returned no upload slot for a file.');
      return { f, slot, token: randomUUID() };
    });
    for (const { f, slot, token } of refs) {
      batch.add(token);
      this.held.set(token, { channelId, name: f.name, size: f.size, url: slot.upload_url, uploadFilename: slot.upload_filename, sent: 0, request: null, answered: null, finished: false, writing: false, batch, idle: undefined });
    }
    this.touch(batch);
    return refs.map(({ f, token }) => ({ token, name: f.name, size: f.size }));
  }

  /** Sends the next piece on; resolves once it is handed to the network. Pieces arrive in order, from offset 0. */
  async chunk(tokenArg: unknown, offset: unknown, bytes: unknown): Promise<void> {
    const [, u] = this.get(tokenArg);
    if (u.finished || u.writing || offset !== u.sent) throw new Error('That upload piece is out of order.');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > UPLOAD_CHUNK_BYTES || u.sent + bytes.length > u.size) throw new Error('Not an upload piece.');
    u.writing = true;
    this.touch(u.batch);
    try {
      const request = u.request ?? this.open(u);
      await new Promise<void>((resolve, reject) => {
        // An early answer (a refusal), a network error or an abort fails the piece rather than leaving it waiting.
        void u.answered!.then(() => reject(new Error('Discord stopped the upload.')), reject);
        request.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), undefined, () => resolve());
      });
      u.sent += bytes.length;
    } finally {
      u.writing = false;
    }
  }

  /** Ends the upload once every byte was sent; throws Discord's refusal. */
  async finish(tokenArg: unknown): Promise<void> {
    const [token, u] = this.get(tokenArg);
    if (u.finished) return;
    if (u.writing || u.sent !== u.size) throw new Error('That upload is missing pieces.');
    const request = u.request ?? this.open(u);
    request.end();
    const status = await u.answered!.catch((err: unknown) => {
      this.drop(token);
      throw err;
    });
    if (status < HTTP_OK_MIN || status > HTTP_OK_MAX) {
      this.drop(token);
      throw new Error(`Discord refused the upload (${status}).`);
    }
    u.finished = true;
    this.touch(u.batch);
  }

  /** The finished uploads a message to `channelId` references, in order; they are released. Throws UPLOAD_GONE for one not held. */
  take(channelId: string, tokens: unknown): UploadedFile[] {
    if (!Array.isArray(tokens) || tokens.length > DISCORD_FILES_PER_MESSAGE_MAX) throw new Error('Not the uploads of a message.');
    const uploads = tokens.map((t) => {
      const u = typeof t === 'string' ? this.held.get(t) : undefined;
      if (!u || !u.finished || u.channelId !== channelId) throw new Error(UPLOAD_GONE);
      return u;
    });
    return uploads.map((u, i) => ({ id: String(i), filename: u.name, uploaded_filename: u.uploadFilename }));
  }

  /** Releases uploads a message used (after Discord accepted it). */
  release(tokens: readonly string[]): void {
    for (const t of tokens) this.drop(t);
  }

  private get(tokenArg: unknown): [string, Upload] {
    const u = typeof tokenArg === 'string' ? this.held.get(tokenArg) : undefined;
    if (!u) throw new Error(UPLOAD_GONE);
    return [tokenArg as string, u];
  }

  /** The PUT, streamed (chunked) so nothing buffers the whole file; no cookies go to the store. */
  private open(u: Upload): ClientRequest {
    const request = net.request({ method: 'PUT', url: u.url, session: this.session, useSessionCookies: false });
    request.chunkedEncoding = true;
    u.request = request;
    // Electron 44 emits 'close' once the body is sent, before 'response' (verified 2026-10-06): it isn't the end of the
    // exchange. A lost connection is an 'error'; a hung one, the sender's finishUpload timeout.
    u.answered = new Promise<number>((resolve, reject) => {
      request.on('response', (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      });
      request.on('error', reject);
      // Dropped (idle): a piece waiting on it fails instead of hanging.
      request.on('abort', () => reject(new Error(UPLOAD_GONE)));
    });
    // Rejections are read by chunk() and finish(); an unread one must not surface as unhandled.
    u.answered.catch(() => undefined);
    return request;
  }

  /** Restarts the idle clock of every upload in the batch. */
  private touch(batch: ReadonlySet<string>): void {
    for (const token of batch) {
      const u = this.held.get(token);
      if (!u) continue;
      clearTimeout(u.idle);
      u.idle = setTimeout(() => this.drop(token), UPLOAD_IDLE_MS);
    }
  }

  private drop(token: string): void {
    const u = this.held.get(token);
    if (!u) return;
    clearTimeout(u.idle);
    if (!u.finished) u.request?.abort();
    this.held.delete(token);
  }
}
