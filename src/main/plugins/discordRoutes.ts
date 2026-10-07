// The Discord routes a plugin may call: those the live client itself sends for the reads and posts plugins make.
import { SNOWFLAKE_DIGITS } from '@shared/discord';
import { apiUrl } from '../discord/api';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const ID = SNOWFLAKE_DIGITS;
/** A reaction's emoji as a path segment: `name:id` or a percent-encoded unicode emoji. */
const EMOJI = '[^/]+';
const MESSAGE = `channels/${ID}/messages/${ID}`;

/** Paths relative to /api/v9/, by method; anything else is refused. */
const ROUTES: Record<Method, readonly string[]> = {
  GET: [`channels/${ID}/messages`, `${MESSAGE}/reactions/${EMOJI}`, `channels/${ID}/threads/search`, `users/${ID}/profile`, `guilds/${ID}/emojis`],
  POST: [`channels/${ID}/messages`, `channels/${ID}/attachments`, `${MESSAGE}/ack`],
  PUT: [`${MESSAGE}/reactions/${EMOJI}/@me`],
  PATCH: [MESSAGE],
  DELETE: [MESSAGE, `${MESSAGE}/reactions/${EMOJI}/@me`],
};
const PATTERNS = Object.fromEntries(Object.entries(ROUTES).map(([m, paths]) => [m, paths.map((p) => new RegExp(`^/api/v9/${p}$`))])) as Record<Method, RegExp[]>;

/** Throws unless `method path` is a route plugins may call (a query string aside). */
export function assertPluginRoute(method: Method, path: string): void {
  const { pathname } = apiUrl(path);
  if (!PATTERNS[method].some((r) => r.test(pathname))) throw new Error(`Plugins may not call Discord's ${method} ${pathname}.`);
}
