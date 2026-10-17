import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Measuring walks the media tree; re-walk at most this often (status is requested on every archive change). */
const SCAN_TTL_MS = 30_000;

/** Bytes on disk under a directory, measured from the filesystem (the truth), cached briefly. A failed scan is not cached. */
export class DirSize {
  private bytes = 0;
  private scannedAt = 0;
  private scanning: Promise<number> | undefined;

  constructor(private readonly dir: string) {}

  async get(): Promise<number> {
    if (Date.now() - this.scannedAt < SCAN_TTL_MS) return this.bytes;
    this.scanning ??= walk(this.dir)
      .then((b) => {
        this.bytes = b;
        this.scannedAt = Date.now();
        return b;
      })
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }
}

/** Eviction and freeing remove files during a walk: a folder or file gone before it is read counts as empty. */
const ifPresent = <T>(read: Promise<T>, missing: T): Promise<T> =>
  read.catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw err;
  });

async function walk(dir: string): Promise<number> {
  let total = 0;
  for (const e of await ifPresent(readdir(dir, { withFileTypes: true }), [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await walk(p);
    else if (e.isFile()) total += (await ifPresent(stat(p), null))?.size ?? 0;
  }
  return total;
}
