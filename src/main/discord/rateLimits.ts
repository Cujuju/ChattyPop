// Discord's REST rate limits as its answers state them: per route, and global. Kept across requests, not per attempt.
import { SNOWFLAKE_ID } from '@shared/discord';
import { MS_PER_S } from '@shared/units';

/** Path segments whose id scopes a route's limit (Discord's major parameters); other ids share the route's bucket. */
const MAJOR_PARAMETERS = new Set(['channels', 'guilds', 'webhooks']);

/** The rate-limit route of a request: method and path, ids generalized except the first major parameter's. */
export function routeKey(method: string, url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  let majorKept = false;
  const route = parts.map((p, i) => {
    if (!SNOWFLAKE_ID.test(p)) return p;
    if (!majorKept && MAJOR_PARAMETERS.has(parts[i - 1] ?? '')) {
      majorKept = true;
      return p;
    }
    return ':id';
  });
  return `${method} /${route.join('/')}`;
}

/** What a rate-limit answer carries. */
export interface LimitAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const HTTP_TOO_MANY_REQUESTS = 429;

/** A positive number of seconds Discord stated, else 0. */
const seconds = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const jsonBody = (body: string): { retry_after?: unknown; global?: unknown } => {
  try {
    const j: unknown = JSON.parse(body);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
};

/** When each route, and every route, may next be sent. */
export class RateLimits {
  private globalUntil = 0;
  private readonly routes = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** When `route` may next be sent (ms since the epoch); a past time means now. */
  until(route: string): number {
    return Math.max(this.globalUntil, this.routes.get(route) ?? 0);
  }

  /** Records the wait an answer states: a 429's retry-after (header or body), or an exhausted bucket's reset. */
  note(route: string, res: LimitAnswer): void {
    const now = this.now();
    for (const [r, t] of this.routes) if (t <= now) this.routes.delete(r);
    if (res.status === HTTP_TOO_MANY_REQUESTS) {
      const body = jsonBody(res.body);
      const waitS = Math.max(seconds(res.headers['retry-after']), seconds(body.retry_after));
      if (!waitS) return;
      const until = now + waitS * MS_PER_S;
      if (res.headers['x-ratelimit-global'] === 'true' || body.global === true) this.globalUntil = Math.max(this.globalUntil, until);
      else this.extend(route, until);
      return;
    }
    const resetS = seconds(res.headers['x-ratelimit-reset-after']);
    if (res.headers['x-ratelimit-remaining'] === '0' && resetS) this.extend(route, now + resetS * MS_PER_S);
  }

  private extend(route: string, until: number): void {
    this.routes.set(route, Math.max(this.routes.get(route) ?? 0, until));
  }
}
