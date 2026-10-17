import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LEAF_CHARS, copyAttachmentsToFolder, exportCandidate } from '../src/main/media/attachmentExports';
import { attachmentShard } from '../src/shared/media';

const SHA = 'b'.repeat(64);
const COLLISIONS = 3;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('export file names', () => {
  it('keeps every candidate within one path component, extension intact', () => {
    const name = `${'n'.repeat(MAX_LEAF_CHARS - '.png'.length)}.png`;
    expect(exportCandidate(name, null)).toBe(name);
    const second = exportCandidate(name, 2);
    expect(second.length).toBe(MAX_LEAF_CHARS);
    expect(second.endsWith(' (2).png')).toBe(true);
  });

  it('never splits a surrogate pair or ends a cut on a dot or space', () => {
    const emoji = '😀';
    const name = `${'n'.repeat(MAX_LEAF_CHARS - ' (2).png'.length - 1)}${emoji}x.png`;
    const cut = exportCandidate(name, 2);
    expect(cut.length).toBeLessThanOrEqual(MAX_LEAF_CHARS);
    expect(cut).not.toMatch(/[\uD800-\uDBFF] \(2\)/);
    expect(exportCandidate(`${'n'.repeat(MAX_LEAF_CHARS - ' (2)'.length - 1)}. tail`, 2)).not.toMatch(/[. ] \(2\)/);
  });

  it('saves a longest-name file beside existing copies under numbered names', async () => {
    const store = await mkdtemp(join(tmpdir(), 'cp-store-')); const folder = await mkdtemp(join(tmpdir(), 'cp-out-'));
    dirs.push(store, folder);
    await mkdir(join(store, attachmentShard(SHA)), { recursive: true });
    await writeFile(join(store, attachmentShard(SHA), `${SHA}.png`), 'x');
    const file = { sha256: SHA, filename: `${'n'.repeat(MAX_LEAF_CHARS - '.png'.length)}.png`, storedExt: null };
    const result = await copyAttachmentsToFolder(store, Array.from({ length: COLLISIONS }, () => file), folder, () => undefined);
    expect(result).toMatchObject({ saved: COLLISIONS, failed: 0 });
    const names = await readdir(folder);
    expect(names.every((n) => n.length <= MAX_LEAF_CHARS && n.endsWith('.png'))).toBe(true);
  });
});
