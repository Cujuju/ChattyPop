import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_CHUNK_BYTES } from '@shared/compose';
import { snowflakeArg } from '@shared/discord';
import { isReplacementExt, type ReplacementExt } from '@shared/attachmentReplacement';
import { SHA256_HEX } from '@shared/media';
import { MS_PER_MIN } from '@shared/units';
import type { MainCore } from '../coreClient';
import { PARTIAL_DOWNLOAD_PREFIX, publishStored } from './attachmentDownloader';

/** Inactive senders release their partial file and hash reservation after ten minutes. */
export const REPLACEMENT_IDLE_MS = 10 * MS_PER_MIN;
const REPLACEMENT_GONE = 'That attachment replacement is no longer held.';

interface Replacement {
  sha256: string;
  ext: ReplacementExt;
  limit: number;
  bytes: number;
  partial: string;
  file: FileHandle;
  hash: Hash;
  busy: Promise<unknown> | null;
  finishing: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** Ordered, bounded writes into the archive's content-addressed store. */
export class StoreReplacements {
  private readonly held = new Map<string, Replacement>();
  private readonly hashes = new Set<string>();
  /** Publication is serialized so failed core calls never delete another replacement's newly shared destination. */
  private publishing: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string, private readonly core: Pick<MainCore, 'call'>) {}

  async begin(attachmentId: unknown, ext: unknown): Promise<{ token: string }> {
    const id = snowflakeArg(attachmentId, 'attachment');
    if (!isReplacementExt(ext)) throw new Error('Not a supported replacement format.');
    const original = await this.core.call('storedFile', id);
    if (!original || !SHA256_HEX.test(original.sha256)) throw new Error('That attachment is not stored.');
    const limit = original.storedBytes;
    if (limit === null || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('That attachment has no stored byte count.');
    if (this.hashes.has(original.sha256)) throw new Error('That stored file is already being replaced.');
    this.hashes.add(original.sha256);
    const token = randomUUID();
    const partial = join(this.dir, `${PARTIAL_DOWNLOAD_PREFIX}${token}`);
    try {
      await mkdir(this.dir, { recursive: true });
      const file = await open(partial, 'wx');
      const replacement: Replacement = { sha256: original.sha256, ext, limit, bytes: 0, partial, file,
        hash: createHash('sha256'), busy: null, finishing: false, idle: undefined };
      this.held.set(token, replacement);
      this.touch(token, replacement);
      return { token };
    } catch (err) {
      this.hashes.delete(original.sha256);
      await rm(partial, { force: true });
      throw err;
    }
  }

  async chunk(tokenArg: unknown, offset: unknown, bytes: unknown): Promise<void> {
    const [token, r] = this.get(tokenArg);
    if (r.finishing || r.busy || offset !== r.bytes) throw new Error('That replacement piece is out of order.');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > UPLOAD_CHUNK_BYTES) throw new Error('Not a replacement piece.');
    if (r.bytes + bytes.length >= r.limit) {
      await this.drop(token);
      throw new Error('The replacement must be smaller than the stored file.');
    }
    this.touch(token, r);
    // Snapshot the piece before asynchronous disk writes; memory is bounded by UPLOAD_CHUNK_BYTES.
    const piece = Buffer.from(bytes);
    r.busy = r.file.writeFile(piece).then(() => { r.hash.update(piece); r.bytes += piece.length; });
    try {
      await r.busy;
      this.get(token);
    } catch (err) {
      await this.drop(token);
      throw err;
    } finally {
      r.busy = null;
    }
  }

  async finish(tokenArg: unknown): Promise<{ savedBytes: number }> {
    const [token, r] = this.get(tokenArg);
    if (r.finishing || r.busy || !r.bytes) throw new Error('That replacement is missing pieces.');
    r.finishing = true;
    clearTimeout(r.idle);
    const published = this.publishing.catch(() => undefined).then(() => this.publish(r));
    r.busy = published;
    this.publishing = published;
    try {
      return await published;
    } finally {
      await this.drop(token);
    }
  }

  async abort(tokenArg: unknown): Promise<void> {
    if (typeof tokenArg !== 'string') throw new Error('Not a replacement token.');
    const r = this.held.get(tokenArg);
    // A finish already handed to core settles before its reservation is released.
    if (r?.finishing) await r.busy?.catch(() => undefined);
    await this.drop(tokenArg);
  }

  private async publish(r: Replacement): Promise<{ savedBytes: number }> {
    await r.file.close();
    const newSha256 = r.hash.digest('hex');
    const { ext } = await publishStored(this.dir, r.partial, newSha256, r.ext);
    // A refusal's cleanup is core's (removeUnnamedFiles): only core knows whether a download now names this content.
    return await this.core.call('attachmentRecompressed', { sha256: r.sha256, newSha256, storedExt: ext, bytes: r.bytes });
  }

  private get(tokenArg: unknown): [string, Replacement] {
    const r = typeof tokenArg === 'string' ? this.held.get(tokenArg) : undefined;
    if (!r) throw new Error(REPLACEMENT_GONE);
    return [tokenArg as string, r];
  }

  private touch(token: string, r: Replacement): void {
    clearTimeout(r.idle);
    r.idle = setTimeout(() => void this.drop(token).catch((err: unknown) => console.warn('[attachment replacement]', err)), REPLACEMENT_IDLE_MS);
    r.idle.unref();
  }

  private async drop(token: string): Promise<void> {
    const r = this.held.get(token);
    if (!r) return;
    this.held.delete(token);
    clearTimeout(r.idle);
    try {
      await r.busy?.catch(() => undefined);
      await r.file.close();
    } finally {
      try { await rm(r.partial, { force: true }); }
      finally { this.hashes.delete(r.sha256); }
    }
  }
}
