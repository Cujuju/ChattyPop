// Publishes loopback services over tailnet HTTPS. Tracks host-created configuration and removes ports for disabled/absent plugins.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IS_WINDOWS, findExecutable } from '@core/ai/resolveCli';
import { errorMessage } from '@shared/errors';
import { MS_PER_S } from '@shared/units';

/** `tailscale serve` answers at once when Serve is enabled; it waits indefinitely when it isn't, printing a link. */
const CLI_TIMEOUT_MS = 15 * MS_PER_S;
/** The line `tailscale serve` prints when the tailnet hasn't enabled Serve (and HTTPS certificates). */
const NOT_ENABLED = /not enabled on your tailnet[\s\S]*?(https:\/\/login\.tailscale\.com\/\S+)/;
/** The mount path a publication serves. Named in every command: `serve --https=<port> off` without it removes the whole port. */
const ROOT_PATH = '/';

/** Why a server can't be published: shown to the owner. `enableUrl` opens Tailscale's page to turn Serve on. */
export class TailnetError extends Error {
  constructor(
    message: string,
    readonly enableUrl: string | null = null,
  ) {
    super(message);
  }
}

/** Runs the Tailscale CLI with `args` and resolves with its output; rejects with TailnetError. */
export type TailscaleCli = (args: string[]) => Promise<string>;

/** The link `tailscale serve` prints when Serve is off for the tailnet; null otherwise. */
export const serveEnableUrl = (output: string): string | null => NOT_ENABLED.exec(output)?.[1] ?? null;

/** This machine's MagicDNS name from `tailscale status --json`, without the trailing dot; null when not connected. */
export function tailnetName(statusJson: string): string | null {
  try {
    const s = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } };
    const name = s.Self?.DNSName?.replace(/\.$/, '');
    return s.BackendState === 'Running' && name ? name : null;
  } catch {
    return null;
  }
}

/** Where `tailscale serve status --json` says HTTPS port `httpsPort` proxies its root to (any of this PC's names). */
export function rootProxies(serveStatusJson: string, httpsPort: number): string[] {
  // Printed empty when nothing is served.
  if (!serveStatusJson.trim()) return [];
  const s = JSON.parse(serveStatusJson) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  return Object.entries(s.Web ?? {}).flatMap(([hostPort, web]) => {
    const proxy = web.Handlers?.[ROOT_PATH]?.Proxy;
    return hostPort.endsWith(`:${httpsPort}`) && proxy ? [proxy] : [];
  });
}

/** The installer's location on Windows is not always on PATH for apps started before it ran. */
function tailscaleExe(): string | null {
  const onPath = findExecutable('tailscale');
  if (onPath) return onPath;
  const installed = IS_WINDOWS ? join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : null;
  return installed && existsSync(installed) ? installed : null;
}

/** The real CLI; rejects with TailnetError, carrying the enable link when Serve is off. */
export const runTailscale: TailscaleCli = (args) => {
  const exe = tailscaleExe();
  if (!exe) return Promise.reject(new TailnetError('Tailscale isn’t installed on this PC.'));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    const finish = (err: TailnetError | null): void => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      if (err) reject(err);
      else resolve(out);
    };
    const onData = (d: Buffer): void => {
      out += d.toString();
      const enableUrl = serveEnableUrl(out);
      if (enableUrl) finish(new TailnetError('Serve and HTTPS certificates are off for your tailnet.', enableUrl));
    };
    const timer = setTimeout(() => finish(new TailnetError('Tailscale didn’t answer.')), CLI_TIMEOUT_MS);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(new TailnetError(`Couldn’t run Tailscale: ${err.message}`)));
    child.on('close', (code) => finish(code === 0 ? null : new TailnetError(out.trim() || `Tailscale exited with code ${code}.`)));
  });
};

/** Serve config ChattyPop set: a plugin's HTTPS port proxying to its loopback server. */
export interface Publication {
  pluginId: string;
  httpsPort: number;
  target: string;
}

const isPublication = (v: unknown): v is Publication => {
  const p = v as Partial<Publication> | null;
  return typeof p?.pluginId === 'string' && Number.isInteger(p.httpsPort) && typeof p.target === 'string';
};

/** Records Serve configuration before setting it. Removes only ports still targeting the recorded service, preserving owner edits. Serializes calls. */
export class TailnetServe {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cli: TailscaleCli,
    private readonly file: string,
    private readonly diag: (event: string, detail: Record<string, unknown>) => void,
    /** Config set by builds from before the record file, adopted while the profile has none. */
    private readonly unrecorded: readonly Publication[] = [],
  ) {}

  /** Proxies `httpsPort` on this PC's tailnet name to loopback `localPort`; resolves with the HTTPS URL. */
  publish(pluginId: string, httpsPort: number, localPort: number): Promise<string> {
    return this.serial(async () => {
      const name = tailnetName(await this.cli(['status', '--json']).catch(() => ''));
      if (!name) throw new TailnetError('Tailscale isn’t connected on this PC.');
      const target = `http://127.0.0.1:${localPort}`;
      // Recorded first: a command that times out may still take effect.
      this.save([...this.read().filter((p) => !(p.pluginId === pluginId && p.httpsPort === httpsPort)), { pluginId, httpsPort, target }]);
      // --bg keeps the config in Tailscale (it survives restarts); --yes skips its prompts.
      await this.cli(['serve', '--bg', '--yes', `--https=${httpsPort}`, `--set-path=${ROOT_PATH}`, target]);
      return `https://${name}:${httpsPort}/`;
    });
  }

  /** Removes the plugin's Serve config on `httpsPort`, if it set one. */
  withdraw(pluginId: string, httpsPort: number): Promise<void> {
    return this.serial(async () => {
      for (const p of this.read().filter((r) => r.pluginId === pluginId && r.httpsPort === httpsPort)) await this.remove(p);
    });
  }

  /** Removes every recorded config whose plugin isn't on (turned off, or not in this build); a failure is retried next call. */
  reconcile(active: (pluginId: string) => boolean): Promise<void> {
    return this.serial(async () => {
      for (const p of this.read().filter((r) => !active(r.pluginId))) {
        await this.remove(p).catch((err: unknown) => this.diag('tailnet-remove-failed', { pluginId: p.pluginId, httpsPort: p.httpsPort, message: errorMessage(err) }));
      }
    });
  }

  /** Turns the port off only while it still proxies to the recorded target; then forgets the record. */
  private async remove(p: Publication): Promise<void> {
    const served = rootProxies(await this.cli(['serve', 'status', '--json']), p.httpsPort);
    if (served.includes(p.target)) await this.cli(['serve', `--https=${p.httpsPort}`, `--set-path=${ROOT_PATH}`, 'off']);
    else if (served.length) this.diag('tailnet-config-replaced', { pluginId: p.pluginId, httpsPort: p.httpsPort });
    this.save(this.read().filter((r) => !(r.pluginId === p.pluginId && r.httpsPort === p.httpsPort)));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private read(): Publication[] {
    if (!existsSync(this.file)) return [...this.unrecorded];
    try {
      const list: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(list) ? list.filter(isPublication) : [];
    } catch {
      return [];
    }
  }

  private save(list: Publication[]): void {
    writeFileSync(this.file, JSON.stringify(list));
  }
}
