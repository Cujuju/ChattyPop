// discord.com's own files load in the Discord page: a sticker by the page's fetch, a font as a font request whose own response is read back.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { pageAsset } from '../src/main/discord/pageAssets';

const FONT = 'https://discord.com/assets/abc.woff2';
const STICKER = 'https://discord.com/stickers/1.json';

/** A page whose fetch answers `fetched`; a font load reports a font request (with `body`) unless `cachedInMemory`. */
function page(o: { fetched?: { status: number; base64: string }; cachedInMemory?: boolean } = {}) {
  const cdp = Object.assign(new EventEmitter(), { sendCommand: vi.fn(async () => ({ body: Buffer.from('font').toString('base64'), base64Encoded: true })) });
  const scripts: string[] = [];
  const evaluate = vi.fn(async (script: string): Promise<unknown> => {
    scripts.push(script);
    if (script.includes('new FontFace')) {
      if (!o.cachedInMemory) {
        cdp.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'r1', type: 'Font', request: { url: FONT } });
        cdp.emit('message', {}, 'Network.loadingFinished', { requestId: 'r1' });
      }
      return true;
    }
    return o.fetched ?? { status: 200, base64: Buffer.from('{}').toString('base64') };
  });
  const webContents = { isDestroyed: () => false, isLoading: () => false, once: () => undefined, debugger: cdp };
  return { p: { webContents: webContents as never, world: { evaluate } as never }, cdp, scripts };
}

describe('discord.com assets through the page', () => {
  it("loads a sticker with the page's own fetch", async () => {
    const f = page();
    const r = await pageAsset(f.p, STICKER);
    expect(await r.text()).toBe('{}');
    expect(f.scripts).toHaveLength(1);
    expect(f.scripts[0]).toContain('await fetch(url)');
  });

  it("loads a font as a font request and reads that request's response, sending nothing more", async () => {
    const f = page();
    const r = await pageAsset(f.p, FONT, 'Sakura');
    expect(await r.text()).toBe('font');
    expect(f.cdp.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
    expect(f.scripts).toHaveLength(1);
  });

  it("falls back to the page's fetch when the font load reported no request (the page already held it)", async () => {
    vi.useFakeTimers();
    try {
      const f = page({ cachedInMemory: true });
      const r = pageAsset(f.p, FONT, 'Sakura');
      await vi.runAllTimersAsync();
      expect(await (await r).text()).toBe('{}');
      expect(f.scripts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers Discord's status, and 502 without a page", async () => {
    expect((await pageAsset(page({ fetched: { status: 404, base64: '' } }).p, STICKER)).status).toBe(404);
    expect((await pageAsset(undefined, STICKER)).status).toBe(502);
  });
});
