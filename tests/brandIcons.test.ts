import { describe, expect, it } from 'vitest';
const modulePath = '../src/renderer/src/ui/brandIcons';
const { BRAND_PATHS, brandPath } = await import(modulePath) as {
  BRAND_PATHS: Readonly<Record<string, string>>;
  brandPath(domain: string): string | undefined;
};

describe('link-domain brand marks', () => {
  it('resolves every supported host to non-empty path data', () => {
    for (const [host, path] of Object.entries(BRAND_PATHS)) {
      expect(path, host).toMatch(/^m\S+/i);
      expect(brandPath(host), host).toBe(path);
    }
  });

  it('resolves subdomains through each parent while giving exact hosts precedence', () => {
    expect(brandPath('music.youtube.com')).toBe(BRAND_PATHS['youtube.com']);
    expect(brandPath('a.b.music.youtube.com')).toBe(BRAND_PATHS['youtube.com']);
    expect(brandPath('music.apple.com')).toBe(BRAND_PATHS['music.apple.com']);
    expect(brandPath('a.music.apple.com')).toBe(BRAND_PATHS['music.apple.com']);
    expect(brandPath('youtu.be')).toBe(BRAND_PATHS['youtube.com']);
  });

  it('leaves unknown hosts and lookalike suffixes unresolved', () => {
    expect(brandPath('unknown.example')).toBeUndefined();
    expect(brandPath('notyoutube.com')).toBeUndefined();
    expect(brandPath('youtube.com.example')).toBeUndefined();
    expect(brandPath('apple.com')).toBeUndefined();
    expect(brandPath('toString')).toBeUndefined();
    expect(brandPath('')).toBeUndefined();
  });
});
