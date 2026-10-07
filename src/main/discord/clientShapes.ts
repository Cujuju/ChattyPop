// Field names of the live client's own requests and gateway sends, per route: ours are checked against them. Names only, never values.
import { readFileSync, writeFileSync } from 'node:fs';
import { SNOWFLAKE_ID } from '@shared/discord';
import { errorMessage } from '@shared/errors';

/** How often the client sent a route, how often each field came with it, and how its body was encoded. */
export interface Shape {
  seen: number;
  fields: Record<string, number>;
  bodies: Record<string, number>;
}
export type Shapes = Record<string, Shape>;

/** A body's encoding: JSON, multipart form (`payload_json` and files), none, or something else. */
export type BodyKind = 'json' | 'multipart' | 'none' | 'other';

/** What a request or frame carried: its body's encoding and its field names (query parameters as `?name`). */
export interface Carried {
  kind: BodyKind;
  fields: string[];
}

/** Collected changes are written this long after the first, so a burst of requests is one write. */
const SAVE_DELAY_MS = 30_000;
/** A multipart body opens with its boundary. */
const MULTIPART_START = '--';

/** A REST route with every id generalized, and a reaction's emoji: `POST /api/v9/channels/:id/messages`. */
export function routeTemplate(method: string, url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  return `${method} /${parts.map((p, i) => (SNOWFLAKE_ID.test(p) ? ':id' : parts[i - 1] === 'reactions' ? ':emoji' : p)).join('/')}`;
}

/** The route of a gateway send. */
export const gatewayRoute = (op: number): string => `gateway op ${op}`;

/** What a request carried: its query's names and its body's top-level field names. */
export function carried(url: URL | null, body: string | null): Carried {
  const query = url ? [...new Set(url.searchParams.keys())].map((k) => `?${k}`) : [];
  if (body === null || body === '') return { kind: 'none', fields: query };
  if (body.startsWith(MULTIPART_START)) return { kind: 'multipart', fields: query };
  try {
    const j: unknown = JSON.parse(body);
    const fields = j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : [];
    return { kind: 'json', fields: [...query, ...fields] };
  } catch {
    return { kind: 'other', fields: query };
  }
}

/** The client's shapes, kept in a profile file across runs; `report` hears of each route ours differ on, once a run. */
export class ClientShapes {
  private readonly shapes: Shapes;
  private saving: ReturnType<typeof setTimeout> | null = null;
  private readonly reported = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly report: (route: string, difference: { extra: string[]; missing: string[]; kind: BodyKind; clientKinds: string[] }) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.shapes = load(file);
  }

  /** The client sent `route` carrying `c`. */
  observe(route: string, c: Carried): void {
    const s = (this.shapes[route] ??= { seen: 0, fields: {}, bodies: {} });
    s.seen++;
    s.bodies[c.kind] = (s.bodies[c.kind] ?? 0) + 1;
    for (const f of new Set(c.fields)) s.fields[f] = (s.fields[f] ?? 0) + 1;
    this.saving ??= setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  /** We are sending `route` carrying `c`: reports fields the client never sent there, ones it always sends that we don't, and a different encoding. */
  check(route: string, c: Carried): void {
    const s = this.shapes[route];
    if (!s?.seen || this.reported.has(route)) return;
    const extra = c.fields.filter((f) => !s.fields[f]);
    const missing = Object.entries(s.fields).filter(([f, n]) => n === s.seen && !f.startsWith('?') && !c.fields.includes(f)).map(([f]) => f);
    const kindSeen = (s.bodies[c.kind] ?? 0) > 0;
    if (!extra.length && !missing.length && kindSeen) return;
    this.reported.add(route);
    this.report(route, { extra, missing, kind: c.kind, clientKinds: Object.keys(s.bodies) });
  }

  /** Writes what was collected now (at quit). */
  flush(): void {
    if (this.saving) this.save();
  }

  private save(): void {
    if (this.saving) clearTimeout(this.saving);
    this.saving = null;
    try {
      writeFileSync(this.file, JSON.stringify(this.shapes));
    } catch (err) {
      this.onError(errorMessage(err));
    }
  }
}

function load(file: string): Shapes {
  try {
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? (j as Shapes) : {};
  } catch {
    // None yet (first run) or unreadable: start empty.
    return {};
  }
}
