import { describe, expect, it } from 'vitest';
import { compressibleAs } from '@shared/attachmentCompression';
import { MIN_SAVINGS, NO_UPLOAD_LIMIT, savesEnough, worthEncoding } from '@shared/videoEncode';

const ORIGINAL_BYTES = 300;
const image = { sha256: 'a'.repeat(64), filename: 'picture.png', storedExt: null,
  status: 'stored', contentType: 'image/png', animated: false, compressed: false };

describe('archive compression decisions', () => {
  it('requires MIN_SAVINGS at the inclusive boundary, independent of upload limits', () => {
    const threshold = ORIGINAL_BYTES * (1 - MIN_SAVINGS);
    expect(savesEnough(ORIGINAL_BYTES, threshold)).toBe(true);
    expect(savesEnough(ORIGINAL_BYTES, threshold + 1)).toBe(false);
    expect(savesEnough(ORIGINAL_BYTES, ORIGINAL_BYTES)).toBe(false);
    expect(worthEncoding(ORIGINAL_BYTES, threshold, NO_UPLOAD_LIMIT)).toBe(true);
    expect(worthEncoding(ORIGINAL_BYTES, threshold + 1, NO_UPLOAD_LIMIT)).toBe(false);
  });

  it.each([
    ['stored PNG', {}, 'image'],
    ['extension-only image', { contentType: null }, 'image'],
    ['GIF', { filename: 'animation.gif', contentType: 'image/gif' }, null],
    ['GIF with misleading MIME', { filename: 'animation.gif' }, null],
    ['animated PNG', { animated: true }, null],
    ['SVG', { filename: 'vector.svg', contentType: 'image/svg+xml' }, null],
    ['MP4', { filename: 'clip.mp4', contentType: 'video/mp4' }, 'video'],
    ['evicted', { status: 'evicted' }, null],
    ['compressed', { compressed: true }, null],
    ['removed', { removed: true }, null],
    ['unhashed', { sha256: '' }, null],
    ['audio', { filename: 'sound.mp3', contentType: 'audio/mpeg' }, null],
    ['opaque file', { filename: 'archive.zip', contentType: null }, null],
  ] as const)('%s', (_name, patch, kind) => {
    expect(compressibleAs({ ...image, ...patch })).toBe(kind);
  });
});
