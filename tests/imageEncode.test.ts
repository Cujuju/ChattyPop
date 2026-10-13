import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_IMAGE_QUALITY, WEBP_TYPE } from '@shared/imageEncode';

const ENCODER_MODULE = '../src/renderer/src/state/imageEncode';
const { encodeImageForArchive } = await import(ENCODER_MODULE) as {
  encodeImageForArchive(blob: Blob, opts: { signal?: AbortSignal }): Promise<{ kind: 'encoded'; file: Blob } | { kind: 'unsupported' }>;
};
const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 768;
const bitmap = { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, close: vi.fn() };
const convert = vi.fn();
const draw = vi.fn();
const dimensions = vi.fn();
const decode = vi.fn();
const blob = new Blob(['original']);

beforeEach(() => {
  bitmap.close.mockReset();
  draw.mockReset();
  dimensions.mockReset();
  decode.mockReset().mockResolvedValue(bitmap);
  convert.mockReset().mockResolvedValue(new Blob(['encoded'], { type: WEBP_TYPE }));
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) { dimensions(width, height); }
    getContext() { return { drawImage: draw }; }
    convertToBlob = convert;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('archive image encoder', () => {
  it('keeps original pixel dimensions, uses archive WebP quality and closes the bitmap', async () => {
    const result = await encodeImageForArchive(blob, {});
    expect(result.kind).toBe('encoded');
    expect(dimensions).toHaveBeenCalledWith(IMAGE_WIDTH, IMAGE_HEIGHT);
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(convert).toHaveBeenCalledWith({ type: WEBP_TYPE, quality: ARCHIVE_IMAGE_QUALITY });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('reports unsupported decode failures', async () => {
    decode.mockRejectedValue(new Error('Invalid image'));
    await expect(encodeImageForArchive(blob, {})).resolves.toEqual({ kind: 'unsupported' });
    expect(convert).not.toHaveBeenCalled();
  });

  it('closes a bitmap decoded after cancellation and rejects with the signal reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Owner cancelled');
    decode.mockImplementation(async () => { controller.abort(reason); return bitmap; });
    await expect(encodeImageForArchive(blob, { signal: controller.signal })).rejects.toBe(reason);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(convert).not.toHaveBeenCalled();
  });

  it('closes the bitmap when conversion fails or returns a fallback format', async () => {
    convert.mockRejectedValueOnce(new Error('Encoder unavailable'));
    await expect(encodeImageForArchive(blob, {})).resolves.toEqual({ kind: 'unsupported' });
    convert.mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }));
    await expect(encodeImageForArchive(blob, {})).resolves.toEqual({ kind: 'unsupported' });
    expect(bitmap.close).toHaveBeenCalledTimes(2);
  });

  it('reports unsupported devices without decoding', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    await expect(encodeImageForArchive(blob, {})).resolves.toEqual({ kind: 'unsupported' });
    expect(decode).not.toHaveBeenCalled();
  });
});
