import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Measuring walks the media tree; re-walk at most this often (status is requested on every archive change). */
const SCAN_TTL_MS = 30_000;

/** Bytes on disk under a directory, measured from the filesystem (the truth), cached briefly. */
export class DirSize {
  private bytes = 0;
  private scannedAt = 0;
  private scanning: Promise<number> | undefined;

  constructor(private readonly dir: string) {}

  async get(): Promise<number> {
    if (Date.now() - this.scannedAt < SCAN_TTL_MS) return this.bytes;
    this.scanning ??= walk(this.dir).then((b) => {
      this.bytes = b;
      this.scannedAt = Date.now();
      this.scanning = undefined;
      return b;
    });
    return this.scanning;
  }
}

async function walk(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // not created yet
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await walk(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}
