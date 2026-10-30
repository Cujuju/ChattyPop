import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SAFE_EXT, attachmentFileName, attachmentShard, fileExt } from '@shared/media';

/** In-flight files are excluded from archive moves and removed after an interrupted run. */
export const PARTIAL_DOWNLOAD_PREFIX = '.part-';

/** A bounded upload tee; local disk failures leave Discord's upload unaffected. */
export class PartialAttachment {
  private readonly path: string;
  private readonly hash = createHash('sha256');
  private tail: Promise<void> = Promise.resolve();
  private dropped = false;
  bytes = 0;

  constructor(private readonly dir: string, private readonly onDiscard?: (copy: PartialAttachment) => void) {
    this.path = join(dir, `${PARTIAL_DOWNLOAD_PREFIX}${randomUUID()}`);
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.dropped) return Promise.resolve();
    this.tail = this.tail.then(async () => {
      if (this.dropped) return;
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.path, bytes);
      this.hash.update(bytes);
      this.bytes += bytes.length;
    });
    return this.tail.catch(() => this.discard());
  }

  async publish(filename: string) {
    await this.tail;
    if (this.dropped) throw new Error('Upload copy discarded.');
    if (!this.bytes) await this.write(new Uint8Array());
    const sha = this.hash.digest('hex');
    return filePartial(this.dir, this.path, sha, this.bytes, filename);
  }

  async discard(): Promise<void> {
    this.dropped = true;
    this.onDiscard?.(this);
    await this.tail.catch(() => undefined);
    await rm(this.path, { force: true });
  }
}

export async function filePartial(dir: string, partial: string, sha: string, bytes: number, filename: string) {
  const { ext } = await publishStored(dir, partial, sha, fileExt(filename));
  const storedExt = ext === fileExt(filename) ? null : ext;
  return { sha, bytes, storedExt, name: attachmentFileName({ sha256: sha, filename, storedExt }) };
}

export async function storeBody(dir: string, body: ReadableStream<Uint8Array>, filename: string) {
  await mkdir(dir, { recursive: true });
  const partial = join(dir, `${PARTIAL_DOWNLOAD_PREFIX}${randomUUID()}`);
  try {
    const hash = createHash('sha256');
    const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    let bytes = 0;
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(source, createWriteStream(partial));
    return await filePartial(dir, partial, hash.digest('hex'), bytes, filename);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Publishes one file per hash, reusing an existing extension; returns the stored extension, path and whether it existed. */
export async function publishStored(dir: string, partial: string, sha256: string, ext: string): Promise<{ ext: string; path: string; existed: boolean }> {
  const shard = join(dir, attachmentShard(sha256));
  await mkdir(shard, { recursive: true });
  const prefix = `${sha256}.`;
  const held = (await readdir(shard)).find((name) => name.startsWith(prefix) && SAFE_EXT.test(name.slice(prefix.length)));
  if (held) {
    await rm(partial, { force: true });
    return { ext: held.slice(prefix.length), path: join(shard, held), existed: true };
  }
  const path = join(shard, attachmentFileName({ sha256, filename: '', storedExt: ext }));
  await rename(partial, path);
  return { ext, path, existed: false };
}

