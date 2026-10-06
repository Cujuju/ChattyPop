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

/** Observes the embedded client's own API traffic: captures auth headers and the page sizes it requests. */
export class HeaderCapture {
  private headers: ClientHeaders | undefined;
  /** History page limits observed from the live client. */
  readonly observedLimits: number[] = [];

  /** Called whenever headers are (re)captured after being absent: login, restart, or token refresh. */
  onAvailable: (() => void) | undefined;

  constructor(ses: Session) {
    ses.webRequest.onBeforeSendHeaders({ urls: [API_URL_PATTERN] }, (details, callback) => {
      const h = details.requestHeaders;
      const authorization = h['Authorization'] ?? h['authorization'];
      if (authorization && details.webContentsId !== undefined) {
        const wasAbsent = this.headers === undefined;
        const extra = sessionHeaders(h);
        this.headers = { authorization, extra, capturedAt: Date.now() };
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

  get current(): ClientHeaders | undefined {
    return this.headers;
  }

  /** Called on 401: the captured token is stale until the client sends a fresh request. */
  invalidate(): void {
    this.headers = undefined;
  }
}
