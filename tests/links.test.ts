import { describe, expect, it } from 'vitest';
import { classify, extractLinks, normalizeUrl } from '../src/core/derive/links';

describe('link canonicalization', () => {
  it('maps mirrors and short links to one URL per post', () => {
    expect(normalizeUrl('https://youtu.be/abc123')).toBe(normalizeUrl('https://www.youtube.com/watch?v=abc123'));
    expect(normalizeUrl('https://fxtwitter.com/a/status/1')).toBe(normalizeUrl('https://x.com/a/status/1'));
    expect(normalizeUrl('https://vxtwitter.com/a/status/1')).toBe(normalizeUrl('https://twitter.com/a/status/1'));
    // One URL per X post whatever the path form.
    expect(normalizeUrl('https://x.com/someone/status/1000000000000000002/photo/1?s=20')).toBe('https://x.com/i/status/1000000000000000002');
    expect(normalizeUrl('https://x.com/i/web/status/1000000000000000002')).toBe('https://x.com/i/status/1000000000000000002');
    expect(normalizeUrl('https://x.com/someone')).toBe('https://x.com/someone');
  });

  it('classifies by host', () => {
    expect(classify('https://fixupx.com/a/status/1')).toBe('x');
    expect(classify('https://www.reddit.com/r/x')).toBe('reddit');
    expect(classify('https://example.com')).toBe('other');
  });

  it('lists each URL once, with the metadata of the embed Discord unfurled for it', () => {
    const links = extractLinks('see https://youtu.be/abc123 and <https://example.com/b>', [
      { url: 'https://www.youtube.com/watch?v=abc123', title: 'A video', provider: { name: 'YouTube' } },
    ]);
    expect(links).toEqual([
      expect.objectContaining({ url: normalizeUrl('https://youtu.be/abc123'), platform: 'youtube', title: 'A video', site: 'YouTube' }),
      expect.objectContaining({ url: normalizeUrl('https://example.com/b'), platform: 'other', title: null }),
    ]);
  });
});
