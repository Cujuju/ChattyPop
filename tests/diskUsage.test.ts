// The archive's media size (archive status): a file removed between listing and measuring is skipped, and a failed
// scan is never remembered, so the next request walks again.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

const fs = vi.hoisted(() => ({ statFailures: [] as NodeJS.ErrnoException[], statCalls: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: async (...args: Parameters<typeof real.stat>) => {
      fs.statCalls++;
      const failure = fs.statFailures.shift();
      if (failure) throw failure;
      return real.stat(...args);
    },
  };
});
const { DirSize } = await import('../src/core/diskUsage');

const FILE_BYTES = 6;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

function media(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'shard'));
  writeFileSync(join(dir, 'shard', 'file.bin'), Buffer.alloc(FILE_BYTES));
  writeFileSync(join(dir, 'other.bin'), Buffer.alloc(FILE_BYTES));
  return dir;
}

afterEach(() => {
  fs.statFailures.length = 0;
  fs.statCalls = 0;
});

describe('media folder size', () => {
  it('skips a file removed between listing and measuring', async () => {
    fs.statFailures.push(errno('ENOENT'));
    await expect(new DirSize(media()).get()).resolves.toBe(FILE_BYTES);
  });

  it('does not keep a failed scan: the next request walks again', async () => {
    const size = new DirSize(media());
    fs.statFailures.push(errno('EACCES'));
    await expect(size.get()).rejects.toThrow('EACCES');
    const before = fs.statCalls;
    await expect(size.get()).resolves.toBe(2 * FILE_BYTES);
    expect(fs.statCalls).toBeGreaterThan(before);
  });
});
