// Discord's REST API as the app and plugins use it, through the embedded client's session (law 4); DiscordApi implements it.

/** A query string's values; undefined ones are left out. */
export type DiscordQuery = Record<string, string | number | undefined>;

/**
 * Where the live client says an action came from (its X-Context-Properties); passed per call, never captured. No
 * location: the client's `{}`, as it sends for a DM opened from a profile.
 */
export interface RequestContext {
  location?: string;
}

/** One request's own options. */
export interface RequestOptions {
  /** Run just before each attempt is sent, after any queue wait; throwing aborts the request unsent. */
  guard?: () => void | Promise<void>;
}

/** One write's own options. */
export interface WriteOptions extends RequestOptions {
  /** Sent as X-Context-Properties, as the client sends it for this action. */
  context?: RequestContext;
  /** Discord can't deduplicate it: a rate limit is retried, never a server error (which may have applied). */
  once?: boolean;
}

/** X-Context-Properties as the client builds it: base64 of the JSON `{location}`, or of `{}` without one. */
export const contextProperties = (c: RequestContext): string =>
  Buffer.from(JSON.stringify(c.location === undefined ? {} : { location: c.location })).toString('base64');

/** Reads, relative to /api/v9/; one at a time with every other request, and paced unless this is DiscordApi.prompt. */
export interface DiscordReader {
  get<T>(path: string, query?: DiscordQuery, opts?: RequestOptions): Promise<T>;
}

/** Writes, relative to /api/v9/ (upload excepted); in the same queue as the reads. */
export interface DiscordWriter {
  /** Retries 429/5xx, so a body that must not apply twice carries a nonce Discord enforces. */
  post<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T>;
  /** For a body Discord can't deduplicate (no nonce): retries a rate limit, never a server error. */
  postOnce<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T>;
  /** Without a body (adding a reaction); resolves with Discord's answer, unchecked, if it sent one. */
  put(path: string, opts?: WriteOptions): Promise<unknown>;
  patch<T>(path: string, json: unknown, opts?: WriteOptions): Promise<T>;
  /** Resolves with Discord's answer, unchecked, if it sent one (a closed DM's channel). */
  delete(path: string, opts?: WriteOptions): Promise<unknown>;
  /** PUTs bytes to an upload URL Discord handed out; no Discord credentials are sent there. */
  upload(uploadUrl: string, bytes: Buffer): Promise<void>;
}

/** Reads and writes. */
export interface DiscordClient extends DiscordReader, DiscordWriter {}
