// discord.com's own files (sticker art, display-name fonts), loaded inside the Discord page as the client loads them.
import type { WebContents } from 'electron';
import type { PageWorld } from './pageWorld';

/** The Discord page, as asset loads need it; its debugger has Network enabled (the gateway tap's). */
export interface AssetPage {
  webContents: Pick<WebContents, 'isDestroyed' | 'isLoading' | 'once' | 'debugger'>;
  world: Pick<PageWorld, 'evaluate'>;
}

/** Answered when there is no page to load through, or the load itself failed. */
const BAD_GATEWAY = 502;
/**
 * How long after the font has loaded its request's last network event may still be on its way. Assumption: the page
 * reports it before or just after the load settles; past this the font is read with a plain fetch instead.
 */
const FONT_EVENT_WAIT_MS = 1_000;

/** Resolves once `page` has its document: at startup the Archive asks before the page has loaded. */
export async function pageLoaded(page: AssetPage): Promise<void> {
  const wc = page.webContents;
  if (wc.isLoading()) await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()));
}

/** A same-origin fetch in the page: the browser's own headers, cookies and Referer, as the client's own fetches. Bytes come back base64. */
const FETCH = `async (url) => {
  const r = await fetch(url);
  if (!r.ok) return { status: r.status, base64: '' };
  const blob = await r.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const f = new FileReader();
    f.onload = () => resolve(f.result);
    f.onerror = () => reject(f.error);
    f.readAsDataURL(blob);
  });
  return { status: r.status, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}`;

/** Loads a font as the page's @font-face does (a font request); not added to the document. */
const LOAD_FONT = `(url, family) => new FontFace(family, 'url(' + JSON.stringify(url) + ')').load().then(() => true, () => false)`;

/** Loads discord.com `url` through `page`, as a font when `fontFamily` is given; a 502 without a page or when the load failed. */
export async function pageAsset(page: AssetPage | undefined, url: string, fontFamily: string | null = null): Promise<Response> {
  if (!page || page.webContents.isDestroyed()) return new Response(null, { status: BAD_GATEWAY });
  await pageLoaded(page);
  try {
    const font = fontFamily === null ? null : await fontBody(page, url, fontFamily);
    if (font) return new Response(font);
    const r = await page.world.evaluate<{ status: number; base64: string }>(`(${FETCH})(${JSON.stringify(url)})`);
    return new Response(r.base64 ? Buffer.from(r.base64, 'base64') : null, { status: r.status });
  } catch {
    return new Response(null, { status: BAD_GATEWAY });
  }
}

/**
 * The font's bytes, read from its own font request's response (Network.getResponseBody): Discord's fonts vary by Origin,
 * which a fetch doesn't send, so a fetch couldn't reuse that load. Null when the page didn't report the request (a memory
 * cache hit) or it failed.
 */
async function fontBody(page: AssetPage, url: string, family: string): Promise<Buffer | null> {
  const cdp = page.webContents.debugger;
  let requestId: string | null = null;
  let settle: (finished: string | null) => void = () => undefined;
  const ended = new Promise<string | null>((resolve) => (settle = resolve));
  const listen = (_e: unknown, method: string, params: { requestId?: string; type?: string; request?: { url?: string } }): void => {
    if (method === 'Network.requestWillBeSent' && params.type === 'Font' && params.request?.url === url) requestId = params.requestId ?? null;
    else if (requestId !== null && params.requestId === requestId && method === 'Network.loadingFinished') settle(requestId);
    else if (requestId !== null && params.requestId === requestId && method === 'Network.loadingFailed') settle(null);
  };
  cdp.on('message', listen);
  try {
    const loaded = await page.world.evaluate<boolean>(`(${LOAD_FONT})(${JSON.stringify(url)}, ${JSON.stringify(family)})`);
    if (!loaded) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), FONT_EVENT_WAIT_MS)));
    const finished = await Promise.race([ended, late]).finally(() => clearTimeout(timer));
    if (finished === null) return null;
    const body = (await cdp.sendCommand('Network.getResponseBody', { requestId: finished })) as { body: string; base64Encoded: boolean };
    return Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
  } catch {
    return null;
  } finally {
    cdp.off('message', listen);
  }
}
