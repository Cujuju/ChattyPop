import type { Session } from 'electron';
import { diag, redactIds } from '../diagnostics';

/** Headers the Discord web client sends that REST calls must reproduce. Held in memory only, never persisted. */
export interface ClientHeaders {
  authorization: string;
  /** The client's session-wide X-* headers (SESSION_HEADERS), as it last sent them. */
  extra: Record<string, string>;
  capturedAt: number;
}

const API_URL_PATTERN = 'https://discord.com/api/*';
const MESSAGES_PATH = /\/api\/v\d+\/channels\/\d+\/messages\?/;
/** Replays lowercase session X-* headers. Excludes per-request context, failure and audit headers; operations supply their own. */
export const SESSION_HEADERS: ReadonlySet<string> = new Set([
  'x-super-properties',
  'x-fingerprint',
  'x-installation-id',
  'x-discord-locale',
  'x-discord-timezone',
  'x-debug-options',
]);

/** The session-wide headers among `headers`, under the names the client sent them with. */
export const sessionHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => SESSION_HEADERS.has(k.toLowerCase())));

/** A request's identity as webRequest reports it. */
const requestKey = (method: string, url: string): string => `${method} ${url}`;

/** Observes the embedded client's own API traffic: captures auth headers and the page sizes it requests. ChattyPop's requests are not the client's. */
export class HeaderCapture {
  private headers: ClientHeaders | undefined;
  private generation = 0;
  private gatewayAuthorization: string | undefined;
  private readonly invalidations = new Set<(reason: 'replaced' | 'revoked') => void>();
  private readonly captures = new Set<() => void>();
  /** Opaque authentication generation; ordinary header recapture does not change it. No credential leaves this class. */
  get sessionGeneration(): number { return this.generation; }
  onInvalidated(listener: (reason: 'replaced' | 'revoked') => void): () => void {
    this.invalidations.add(listener);
    return () => this.invalidations.delete(listener);
  }
  /** Passive IDENTIFY proof only; this value never supplies REST headers or leaves memory. */
  expectGatewayAuthorization(value: unknown): void { this.gatewayAuthorization = typeof value === 'string' && value.length > 0 ? value : undefined; }
  matchesGatewayAuthorization(value: unknown): boolean { return this.gatewayAuthorization !== undefined && value === this.gatewayAuthorization; }
  get gatewayAuthorized(): boolean { return !!this.headers && this.headers.authorization === this.gatewayAuthorization; }
  onCaptured(listener: () => void): () => void { this.captures.add(listener); return () => this.captures.delete(listener); }
  /** ChattyPop's requests in flight, by requestKey: they replay captured headers, so they say nothing new. */
  private readonly ours = new Map<string, number>();
  /** History page limits observed from the live client. */
  readonly observedLimits: number[] = [];

  /** Called whenever headers are (re)captured after being absent: login, restart, or token refresh. */
  onAvailable: (() => void) | undefined;
  /** Called for each API request the client itself makes, with its body as text (null without one). */
  onClientRequest: ((method: string, url: string, body: string | null) => void) | undefined;

  constructor(ses: Session) {
    ses.webRequest.onBeforeRequest({ urls: [API_URL_PATTERN] }, (details, callback) => {
      if (!this.ours.has(requestKey(details.method, details.url))) {
        const bytes = (details.uploadData ?? []).flatMap((u) => (u.bytes ? [u.bytes] : []));
        this.onClientRequest?.(details.method, details.url, bytes.length ? Buffer.concat(bytes).toString('utf8') : null);
      }
      callback({});
    });
    ses.webRequest.onBeforeSendHeaders({ urls: [API_URL_PATTERN] }, (details, callback) => {
      const h = details.requestHeaders;
      if (this.ours.has(requestKey(details.method, details.url))) return callback({ requestHeaders: h });
      const authorization = h['Authorization'] ?? h['authorization'];
      if (authorization && details.webContentsId !== undefined) {
        const wasAbsent = this.headers === undefined;
        if (this.headers && this.headers.authorization !== authorization) this.invalidate('replaced');
        const extra = sessionHeaders(h);
        this.headers = { authorization, extra, capturedAt: Date.now() };
        for (const listener of this.captures) listener();
        if (wasAbsent) {
          diag('session-captured', { customHeaders: Object.keys(extra) });
          this.onAvailable?.();
        }
      }
      if (MESSAGES_PATH.test(details.url)) {
        const limit = Number(new URL(details.url).searchParams.get('limit'));
        if (limit > 0) this.observedLimits.push(limit);
      }
      callback({ requestHeaders: h });
    });
    // Auth failures on any request in the Discord session (the client's own or ours) are what log a user out.
    ses.webRequest.onCompleted({ urls: [API_URL_PATTERN] }, (details) => {
      if (details.statusCode === 401 || details.statusCode === 403) {
        diag('discord-auth-failure', { status: details.statusCode, path: redactIds(new URL(details.url).pathname) });
      }
    });
  }

  /** Marks a request ChattyPop is about to send; call the result once it has been answered. */
  own(method: string, url: string): () => void {
    const key = requestKey(method, url);
    this.ours.set(key, (this.ours.get(key) ?? 0) + 1);
    return () => {
      const n = (this.ours.get(key) ?? 1) - 1;
      if (n > 0) this.ours.set(key, n);
      else this.ours.delete(key);
    };
  }

  get current(): ClientHeaders | undefined {
    return this.headers;
  }

  /** Called on a 401, or when the client shows its login page: the token is void until the client authorizes a request again. */
  invalidate(reason: 'replaced' | 'revoked' = 'revoked'): void {
    this.headers = undefined;
    if (reason === 'revoked') this.gatewayAuthorization = undefined;
    this.generation++;
    for (const listener of this.invalidations) listener(reason);
  }
}
