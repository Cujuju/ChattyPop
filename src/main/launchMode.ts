// How this run starts: the app (server and window together), a server for other machines, or a client of one.
// docs/server-client-split-plan.md §6.1.

/** Selects the mode when no flag does: `server` or `client` (useful for a service or a shortcut). */
export const LAUNCH_MODE_ENV = 'CHATTYPOP_MODE';
const SERVER_FLAG = '--server';
/** With --server: print a pairing code once the phone transport serves. */
const PAIR_FLAG = '--pair';
/** `--connect` (pick a saved server) or `--connect=<https origin>`. */
const CONNECT_FLAG = '--connect';

export type LaunchMode =
  | { kind: 'app' }
  /** Runs hidden, keeps running when its window closes, shows no toasts here: devices connect to it. */
  | { kind: 'server'; printPairing: boolean }
  /** Opens a server's desktop UI; `origin` null shows the saved servers. */
  | { kind: 'client'; origin: string | null };

/** An https origin from what the owner typed (`host.tailnet.ts.net:8443`, a full URL); null when it isn't one. */
export function serverOrigin(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

/** The mode argv asks for, else the environment's, else the app. A malformed --connect origin shows the saved servers. */
export function launchMode(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LaunchMode {
  const connect = argv.find((a) => a === CONNECT_FLAG || a.startsWith(`${CONNECT_FLAG}=`));
  if (connect !== undefined) return { kind: 'client', origin: connect.includes('=') ? serverOrigin(connect.slice(connect.indexOf('=') + 1)) : null };
  if (argv.includes(SERVER_FLAG)) return { kind: 'server', printPairing: argv.includes(PAIR_FLAG) };
  const mode = env[LAUNCH_MODE_ENV]?.trim().toLowerCase();
  if (mode === 'server') return { kind: 'server', printPairing: argv.includes(PAIR_FLAG) };
  if (mode === 'client') return { kind: 'client', origin: null };
  return { kind: 'app' };
}
