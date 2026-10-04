import { describe, expect, it } from 'vitest';
import { animatedMediaUrl, attachmentView } from '@shared/media';
import { embedsFrom } from '../src/core/queries/messageExtras';
import { byteRange, rangedResponse } from '../src/main/media/ranges';

const SIZE = 1000;
const bytes = new Uint8Array(SIZE).map((_, i) => i % 256);
const serve = (range: string | null): Response => rangedResponse(range, SIZE, 'video/mp4', (start, end) => bytes.subarray(start, end + 1));

describe('byte ranges', () => {
  it('reads first-last, open-ended and suffix ranges, clamped to the body', () => {
    expect(byteRange('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
    expect(byteRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    expect(byteRange('bytes=990-5000', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('serves the whole body for no, malformed or multi-part ranges', () => {
    for (const h of [null, 'bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=5-2']) expect(byteRange(h, SIZE)).toBeNull();
  });

  it('refuses a range starting past the end', () => {
    expect(byteRange(`bytes=${SIZE}-`, SIZE)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  it('answers a range with 206 and just those bytes (iOS probes with bytes=0-1 before it plays)', async () => {
    const r = serve('bytes=0-1');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
    expect(r.headers.get('content-length')).toBe('2');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([0, 1]);
  });

  it('answers no range with the whole body, advertising ranges', async () => {
    const r = serve(null);
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect((await r.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('answers an unsatisfiable range with 416 and the size', () => {
    const r = serve(`bytes=${SIZE}-`);
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${SIZE}`);
  });
});

describe('embed video', () => {
  const PROXIED = 'https://images-ext-1.discordapp.net/external/x/https/video.twimg.com/a.mp4';

  it('keeps an embed fixer’s video on a rich embed (fxTwitter, fxTikTok)', () => {
    const [e] = embedsFrom(JSON.stringify([{ type: 'rich', url: 'https://fxtwitter.com/a/status/1', video: { url: 'https://video.twimg.com/a.mp4', proxy_url: PROXIED } }]));
    expect(e?.videoUrl).toBe(PROXIED);
  });

  it('leaves a player page (no proxied file) unplayable', () => {
    const [e] = embedsFrom(JSON.stringify([{ type: 'video', url: 'https://youtu.be/x', video: { url: 'https://www.youtube.com/embed/x' } }]));
    expect(e?.videoUrl).toBeNull();
  });
});

describe('embed images', () => {
  it('asks Discord’s media proxy for the animation, and leaves other hosts alone', () => {
    expect(animatedMediaUrl('https://images-ext-1.discordapp.net/external/x/https/gif.fxtwitter.com/a.webp')).toBe('https://images-ext-1.discordapp.net/external/x/https/gif.fxtwitter.com/a.webp?animated=true');
    expect(animatedMediaUrl('https://pbs.twimg.com/media/a.jpg')).toBe('https://pbs.twimg.com/media/a.jpg');
  });
});

// A stored video plays in place; a download link would take the phone app away from the page.
describe('attachment views', () => {
  it('plays stored video and audio inline, shows stored images, and chips everything else', () => {
    const stored = (contentType: string | null, filename = 'clip.bin') => attachmentView({ status: 'stored', contentType, filename });
    expect(stored('video/quicktime')).toBe('video');
    expect(stored('audio/ogg')).toBe('audio');
    expect(stored('image/png')).toBe('image');
    expect(stored('application/pdf')).toBe('file');
    expect(stored(null)).toBe('file');
    expect(attachmentView({ status: 'pending', contentType: 'video/mp4', filename: 'clip.mp4' })).toBe('file');
  });

  it('reads the stored extension when the content type is missing or generic', () => {
    const stored = (contentType: string | null, filename: string) => attachmentView({ status: 'stored', contentType, filename });
    expect(stored(null, 'Screen Recording.MOV')).toBe('video');
    expect(stored('application/octet-stream', 'memo.ogg')).toBe('audio');
    expect(stored(null, 'photo.jpeg')).toBe('image');
    expect(stored(null, 'notes.zip')).toBe('file');
  });
});
