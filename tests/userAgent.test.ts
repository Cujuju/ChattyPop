import { describe, expect, it } from 'vitest';
import { browserUserAgent } from '../src/main/appIdentity';

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) chattypop/0.155.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';

describe('browserUserAgent', () => {
  it("is Chromium's reduced user agent, with nothing naming the app or Electron", () => {
    expect(browserUserAgent(ELECTRON_UA, '152.0.7977.130')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    );
  });

  it('refuses a user agent it cannot clean', () => {
    expect(() => browserUserAgent('ChattyPop/1', '152.0.7977.130')).toThrow(/refusing/);
  });
});
