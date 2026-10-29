// Requests sent from inside the embedded Discord page.
import type { WebContents } from 'electron';
import type { PageWorld } from './pageWorld';

export interface PageResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PageRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  /** Text body, or bytes as base64 (a page script carries only strings). */
  body?: { text: string } | { base64: string };
  /** 'include' for Discord's API (the client's cookies); 'omit' for the upload host. */
  credentials: 'include' | 'omit';
}

/** The embedded Discord page: whether it still exists, and the isolated world scripts run in. */
export interface DiscordPage {
  webContents: Pick<WebContents, 'isDestroyed'>;
  world: Pick<PageWorld, 'evaluate'>;
}

/**
 * Runs fetch() inside the embedded Discord page, so every request is a same-origin browser request from
 * discord.com: identical TLS, cookies, Origin, Referer and Sec-Fetch-* headers to the client's own. The isolated world's
 * fetch is the browser's own, not one the page wrapped.
 */
export function pageFetch(page: DiscordPage, url: string, req: PageRequest): Promise<PageResponse> {
  const script = `(async () => {
    const q = ${JSON.stringify(req)};
    const body = !q.body ? undefined : 'text' in q.body ? q.body.text : Uint8Array.from(atob(q.body.base64), (c) => c.charCodeAt(0));
    const r = await fetch(${JSON.stringify(url)}, { method: q.method, headers: q.headers, body, credentials: q.credentials });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, body: await r.text() };
  })()`;
  return page.world.evaluate<PageResponse>(script);
}
