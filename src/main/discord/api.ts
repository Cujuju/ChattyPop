import type { WebContents } from 'electron';
import { sleep } from '@shared/async';
import { DiscordHttpError } from '@shared/discord';
import type { PaceTiming } from '@shared/settings';
import { MS_PER_S } from '@shared/units';
import { diag, redactIds } from '../diagnostics';
import { jittered } from '../sync/pace';
import type { HeaderCapture } from './capture';
import type { PageWorld } from './pageWorld';
import { RateLimits, routeKey } from './rateLimits';
import { carried, routeTemplate, type ClientShapes } from './clientShapes';
import { contextProperties, type DiscordClient, type DiscordQuery, type RequestContext, type RequestOptions, type WriteOptions } from './client';

const API_BASE = 'https://discord.com/api/v9/';
/** Hard floor before a paced request whatever the pace setting says (the prompt lane isn't paced). */
const MIN_REQUEST_INTERVAL_MS = 1000;
/** Retries for 429/5xx before giving up on one request. */
const MAX_ATTEMPTS = 5;

export class DiscordAuthError extends Error {}

interface PageResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface PageRequest {
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
function pageFetch(page: DiscordPage, url: string, req: PageRequest): Promise<PageResponse> {
  const script = `(async () => {
    const q = ${JSON.stringify(req)};
    const body = !q.body ? undefined : 'text' in q.body ? q.body.text : Uint8Array.from(atob(q.body.base64), (c) => c.charCodeAt(0));
    const r = await fetch(${JSON.stringify(url)}, { method: q.method, headers: q.headers, body, credentials: q.credentials });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, body: await r.text() };
  })()`;
  return page.world.evaluate<PageResponse>(script);
}

/** An Invalid Form Body's field errors (`{ attachments: { 0: { description: { _errors: [{ message }] } } } }`) as `path: message`. */
function fieldErrors(errors: unknown, path: readonly string[] = []): string[] {
  if (!errors || typeof errors !== 'object') return [];
  return Object.entries(errors).flatMap(([key, v]) =>
    key === '_errors' && Array.isArray(v) ? v.map((e) => `${path.join('.')}: ${String((e as { message?: unknown }).message)}`) : fieldErrors(v, [...path, key]),
  );
}

/** Discord's reason in an error body, when it gives one, with the fields it refused. */
export function discordReason(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown; captcha_key?: unknown; errors?: unknown };
    if (j.captcha_key) return 'Discord asked for a captcha; post once by hand in the live client, then try again.';
    const message = typeof j.message === 'string' ? j.message : '';
    const fields = fieldErrors(j.errors);
    return fields.length ? `${message} (${fields.join('; ')})` : message;
  } catch {
    return '';
  }
}

/** `path` under /api/v9/ with `query`; one resolving anywhere else (an absolute URL, `/...`, `..`) is refused before any header is attached. */
export function apiUrl(path: string, query: DiscordQuery = {}): URL {
  const url = new URL(path, API_BASE);
  if (!url.href.startsWith(API_BASE)) throw new Error(`Not a Discord API path: ${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url;
}

/** Prompt requests follow the in-flight request ahead of queued paced work. Background requests retain configured pacing. */
type Lane = 'prompt' | 'paced';

interface Job {
  /** Its rate-limit route (rateLimits.ts). */
  route: string;
  /** Sends the request and settles its caller; never rejects. */
  run: () => Promise<void>;
  fail: (err: unknown) => void;
}

/** Uses embedded Discord session headers. Prompt and paced requests share a single queue; only one request runs at a time. */
export class DiscordApi implements DiscordClient {
  private lastRequestAt = 0;
  private readonly lanes: Record<Lane, Job[]> = { prompt: [], paced: [] };
  private pumping = false;
  /** When the oldest paced request may go; set once per wait so a wake doesn't redraw its jitter. */
  private pacedDueAt: number | null = null;
  /** Ends the pump's pace wait early. */
  private wake: (() => void) | null = null;
  private readonly limits = new RateLimits();
  private readonly paced = this.client('paced');
  /** For what the owner does and automatic posts: not held back (the owner's choice). */
  readonly prompt = this.client('prompt');

  constructor(
    private readonly page: () => DiscordPage | undefined,
    private readonly capture: HeaderCapture,
    private readonly pace: () => Promise<PaceTiming>,
    /** Checks each request's shape against the client's own on its route. */
    private readonly shapes: Pick<ClientShapes, 'check'> = { check: () => undefined },
  ) {}

  /** GET `path` (relative to /api/v9/), paced. */
  get<T>(path: string, query: DiscordQuery = {}, opts?: RequestOptions): Promise<T> {
    return this.paced.get<T>(path, query, opts);
  }

  /** POST a JSON body to `path`, paced (DiscordWriter.post). */
  post<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T> {
    return this.paced.post<T>(path, json, opts);
  }

  /** POST a body Discord can't deduplicate, paced (DiscordWriter.postOnce). */
  postOnce<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T> {
    return this.paced.postOnce<T>(path, json, opts);
  }

  /** PUT with no body to `path`, paced. */
  put(path: string, opts?: WriteOptions): Promise<unknown> {
    return this.paced.put(path, opts);
  }

  /** PUT a JSON body to `path`, paced (DiscordWriter.putJson). */
  putJson<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T> {
    return this.paced.putJson<T>(path, json, opts);
  }

  /** PATCH a JSON body to `path`, paced. */
  patch<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T> {
    return this.paced.patch<T>(path, json, opts);
  }

  /** DELETE `path`, paced. */
  delete(path: string, opts?: WriteOptions): Promise<unknown> {
    return this.paced.delete(path, opts);
  }

  /** Retries 429/5xx requests. Repeatable writes need enforced nonces; once writes retry only rate limits because server errors may follow successful writes. */
  private client(lane: Lane): DiscordClient {
    const paced = lane === 'paced';
    const request = <T>(path: string, query: DiscordQuery, method: PageRequest['method'], body: PageRequest['body'], opts: WriteOptions = {}): Promise<T> => {
      let url: URL;
      try {
        url = apiUrl(path, query);
      } catch (err) {
        return Promise.reject(err);
      }
      return this.enqueue(lane, routeKey(method, url), () => this.send<T>(url, method, body, { retryServerErrors: !opts.once, paced, context: opts.context, guard: opts.guard }));
    };
    // Undefined sends no body (typing), as the client does.
    const json = (v: unknown): PageRequest['body'] => (v === undefined ? undefined : { text: JSON.stringify(v) });
    return {
      get: <T>(path: string, query: DiscordQuery = {}, opts?: RequestOptions) => request<T>(path, query, 'GET', undefined, opts),
      post: <T>(path: string, body: unknown, opts?: WriteOptions) => request<T>(path, {}, 'POST', json(body), opts),
      postOnce: <T>(path: string, body: unknown, opts?: WriteOptions) => request<T>(path, {}, 'POST', json(body), { ...opts, once: true }),
      put: (path: string, opts?: WriteOptions) => request<unknown>(path, {}, 'PUT', undefined, opts),
      putJson: <T>(path: string, body: unknown, opts?: WriteOptions) => request<T>(path, {}, 'PUT', json(body), opts),
      patch: <T>(path: string, body: unknown, opts?: WriteOptions) => request<T>(path, {}, 'PATCH', json(body), opts),
      delete: (path: string, opts?: WriteOptions) => request<unknown>(path, {}, 'DELETE', undefined, opts),
      upload: (uploadUrl: string, bytes: Buffer) => this.upload(uploadUrl, bytes),
    };
  }

  /** PUT bytes to an upload URL Discord handed out (its attachment store): no Discord credentials are sent there. */
  async upload(uploadUrl: string, bytes: Buffer): Promise<void> {
    const page = this.page();
    if (!page || page.webContents.isDestroyed()) throw new DiscordAuthError('The live Discord client is not open.');
    const res = await pageFetch(page, uploadUrl, { method: 'PUT', headers: {}, body: { base64: bytes.toString('base64') }, credentials: 'omit' });
    if (res.status < 200 || res.status >= 300) throw new Error(`Upload failed (${res.status}).`);
  }

  private enqueue<T>(lane: Lane, route: string, request: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push({ route, run: () => request().then(resolve, reject), fail: reject });
      this.wake?.();
      void this.pump();
    });
  }

  /** Runs one request at a time, preserving lane order. Prompt requests precede paced requests; paced requests wait since the last send, and out their route's rate limit. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const prompt = this.lanes.prompt.shift();
        if (prompt) {
          await this.dispatch(prompt);
          continue;
        }
        const paced = this.lanes.paced[0];
        if (!paced) return;
        if (this.pacedDueAt === null) {
          try {
            this.pacedDueAt = Math.max(this.lastRequestAt + (await this.paceGap()), this.limits.until(paced.route));
          } catch (err) {
            this.lanes.paced.shift();
            paced.fail(err);
          }
          // A prompt request may have arrived while the pace was read.
          continue;
        }
        const wait = this.pacedDueAt - Date.now();
        if (wait > 0) await this.sleepUnlessWoken(wait);
        else await this.dispatch(this.lanes.paced.shift()!);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async dispatch(job: Job): Promise<void> {
    // The next paced request waits a full pace after this one.
    this.pacedDueAt = null;
    await job.run();
  }

  private async paceGap(): Promise<number> {
    const { apiMs, jitter } = await this.pace();
    return Math.max(MIN_REQUEST_INTERVAL_MS, jittered(apiMs, jitter));
  }

  /** Waits `ms`, or less when a request is queued meanwhile (a prompt one may go first). */
  private sleepUnlessWoken(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** Pump paces first attempts. paced false skips retry pacing, preserving rate-limit waits; guard runs immediately before every attempt. */
  private async send<T>(
    url: URL,
    method: PageRequest['method'],
    body: PageRequest['body'],
    {
      retryServerErrors = true,
      paced = true,
      context,
      guard,
    }: { retryServerErrors?: boolean; paced?: boolean; context?: RequestContext | undefined; guard?: RequestOptions['guard'] } = {},
  ): Promise<T> {
    const route = routeKey(method, url);
    for (let attempt = 1; ; attempt++) {
      if (paced && attempt > 1) await sleep(Math.max(0, this.lastRequestAt + (await this.paceGap()) - Date.now()));
      // Discord's stated wait for this route, or for every route.
      const limited = this.limits.until(route) - Date.now();
      if (limited > 0) await sleep(limited);
      await guard?.();
      const headers = this.capture.current;
      const page = this.page();
      if (!headers || !page || page.webContents.isDestroyed()) throw new DiscordAuthError('Not logged in to Discord (no captured session yet).');
      this.lastRequestAt = Date.now();

      const sent = {
        Authorization: headers.authorization,
        ...headers.extra,
        ...(context ? { 'X-Context-Properties': contextProperties(context) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      };
      if (attempt === 1) this.shapes.check(routeTemplate(method, url), carried(url, body && 'text' in body ? body.text : null));
      // Ours, not the client's: header capture must not take it for the client's latest.
      const release = this.capture.own(method, url.href);
      const res = await pageFetch(page, url.href, { method, headers: sent, body, credentials: 'include' }).finally(release);
      this.limits.note(route, res);
      const redactedPath = redactIds(url.pathname);

      if (res.status === 401) {
        diag('api-401', { path: redactedPath });
        this.capture.invalidate();
        throw new DiscordAuthError('Discord session expired; waiting for the client to re-authenticate.');
      }
      if ((res.status === 429 || (retryServerErrors && res.status >= 500)) && attempt < MAX_ATTEMPTS) {
        diag('api-retry', { path: redactedPath, status: res.status });
        // A stated wait is kept in limits and waited out at the loop's top; without one, back off.
        if (this.limits.until(route) <= Date.now()) await sleep(2 ** attempt * MS_PER_S);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        const reason = discordReason(res.body);
        let code: number | undefined;
        try { const value = JSON.parse(res.body).code; if (Number.isSafeInteger(value)) code = value; } catch { /* Not every error is JSON. */ }
        throw new DiscordHttpError(`Discord ${res.status} on ${redactedPath}${reason ? `: ${reason}` : ''}`, res.status, code);
      }

      // 204 No Content (a reaction PUT, for one) has no body to parse.
      return (res.body ? JSON.parse(res.body) : undefined) as T;
    }
  }
}
