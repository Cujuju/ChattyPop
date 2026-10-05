// Contract: a message's images and videos share Discord's mosaic, rows of three with any remainder leading.
import { describe, expect, it } from 'vitest';
import { DISCORD_FILES_PER_MESSAGE_MAX } from '@shared/discord';
import { inMosaic, mosaicRows } from '../src/renderer/src/panels/chat/mosaic';

describe('media mosaic', () => {
  it("lays out every count a message can hold as Discord does, each tile once", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(mosaicRows)).toEqual([[1], [2], [1, 2], [2, 2], [2, 3], [3, 3], [1, 3, 3], [2, 3, 3], [3, 3, 3], [1, 3, 3, 3]]);
    for (let n = 1; n <= DISCORD_FILES_PER_MESSAGE_MAX; n++) expect(mosaicRows(n).reduce((a, b) => a + b, 0)).toBe(n);
    expect(mosaicRows(0)).toEqual([]);
  });

  it('takes stored images and videos only; audio, files and media not held here stay out', () => {
    const a = (filename: string, status = 'stored') => ({ filename, status, contentType: null });
    expect([a('a.png'), a('b.mov'), a('c.ogg'), a('d.pdf'), a('e.png', 'pending')].map(inMosaic)).toEqual([true, true, false, false, false]);
  });
});
