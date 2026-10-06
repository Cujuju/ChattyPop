// Tracks plugin-owned Tailscale Serve configuration, preserving it at quit and removing it when the plugin disables or leaves the build. Other configuration remains untouched.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import type { PluginInfo } from '@shared/plugins';
import { tempDir } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { PluginStates } = await import('../src/main/plugins/states');
const { startMainPlugins } = await import('../src/main/plugins/bundled');
const { defineMainPlugin } = await import('@plugin-sdk/main');
const { TailnetError, TailnetServe, rootProxies, serveEnableUrl, tailnetName } = await import('../src/main/tailnet');

const HTTPS_PORT = 8443;
const LOCAL_PORT = 47831;
const TARGET = `http://127.0.0.1:${LOCAL_PORT}`;
const NAME = 'pc.tail1.ts.net';

/** Stands in for the Tailscale CLI: Serve's handlers per HTTPS port (path → target), and each command that changed them. */
function fakeTailscale() {
  const ports = new Map<number, Map<string, string>>();
  const changes: string[] = [];
  const mount = (port: number, path: string, target: string): void => void ports.set(port, (ports.get(port) ?? new Map()).set(path, target));
  const cli = async (args: string[]): Promise<string> => {
    const line = args.join(' ');
    if (line === 'status --json') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.` } });
    if (line === 'serve status --json') {
      const web = Object.fromEntries([...ports].map(([port, h]) => [`${NAME}:${port}`, { Handlers: Object.fromEntries([...h].map(([path, target]) => [path, { Proxy: target }])) }]));
      return ports.size ? JSON.stringify({ TCP: Object.fromEntries([...ports.keys()].map((p) => [p, { HTTPS: true }])), Web: web }) : '{}';
    }
    const set = /^serve --bg --yes --https=(\d+) --set-path=(\S+) (\S+)$/.exec(line);
    const off = /^serve --https=(\d+)(?: --set-path=(\S+))? off$/.exec(line);
    if (set) mount(Number(set[1]), set[2]!, set[3]!);
    else if (off) {
      // As Tailscale does: without --set-path, every handler on the port goes.
      const h = ports.get(Number(off[1]));
      if (off[2] === undefined) h?.clear();
      else h?.delete(off[2]);
      if (h?.size === 0) ports.delete(Number(off[1]));
    } else throw new TailnetError(`unexpected: ${line}`);
    changes.push(line);
    return '';
  };
  /** Each port's root target, as `[port, target]` pairs. */
  const roots = (): [number, string | undefined][] => [...ports].map(([port, h]) => [port, h.get('/')]);
  return { ports, changes, cli, mount, root: (port: number) => ports.get(port)?.get('/'), roots };
}

/** A plugin whose main side publishes a loopback server while on, and withdraws it when turned off (as the companion does). */
const publisher = defineMainPlugin(
  definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, network: { loopback: true, tailnet: { httpsPort: HTTPS_PORT } } }),
  (ctx) =>
    ctx.whileActive(async () => {
      await ctx.net.tailnet.publish(LOCAL_PORT);
      return async (reason) => {
        if (reason === 'off') await ctx.net.tailnet.withdraw();
      };
    }),
);

/** One app run: main starts `plugins` with `on` as core's list, over the profile's record file and `tailscale`. */
function run(profile: string, tailscale: ReturnType<typeof fakeTailscale>, plugins: (typeof publisher)[], on: { ids: string[] }) {
  const list = async (): Promise<PluginInfo[]> => on.ids.map((id) => ({ id, bundled: true, status: 'active' }) as PluginInfo);
  const states = new PluginStates(list, () => undefined);
  const tailnet = new TailnetServe(tailscale.cli, join(profile, 'tailnet-serve.json'), () => undefined);
  const main = startMainPlugins(plugins, { core: { call: list, on: () => undefined }, states, tailnet } as never);
  /** Core's list changed (or first arrived): main re-reads it, and what follows the switch settles (the fakes never wait on timers). */
  const snapshot = async (): Promise<void> => {
    states.refresh();
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { main, snapshot };
}

describe('tailnet publishing', () => {
  it('removes, once, the Serve config a plugin left at quit when a later build leaves the plugin out', async () => {
    const profile = tempDir();
    const tailscale = fakeTailscale();
    const first = run(profile, tailscale, [publisher], { ids: ['probe'] });
    await first.snapshot();
    expect(tailscale.root(HTTPS_PORT)).toBe(TARGET);
    await first.main.stop();
    expect(tailscale.root(HTTPS_PORT)).toBe(TARGET);

    const next = run(profile, tailscale, [], { ids: [] });
    await next.snapshot();
    await next.snapshot();
    expect(tailscale.ports.size).toBe(0);
    expect(tailscale.changes.filter((c) => c.endsWith('off'))).toEqual([`serve --https=${HTTPS_PORT} --set-path=/ off`]);
    expect(JSON.parse(readFileSync(join(profile, 'tailnet-serve.json'), 'utf8'))).toEqual([]);
  });

  it('keeps it for a plugin on at the next start, and removes it for one built but off', async () => {
    const profile = tempDir();
    const tailscale = fakeTailscale();
    const first = run(profile, tailscale, [publisher], { ids: ['probe'] });
    await first.snapshot();
    await first.main.stop();
    const on = run(profile, tailscale, [publisher], { ids: ['probe'] });
    await on.snapshot();
    await on.main.stop();
    expect(tailscale.root(HTTPS_PORT)).toBe(TARGET);
    const off = run(profile, tailscale, [publisher], { ids: [] });
    await off.snapshot();
    expect(tailscale.ports.size).toBe(0);
  });

  it('never removes Serve config it didn’t set: the owner’s own, or one that replaced its own', async () => {
    const profile = tempDir();
    const tailscale = fakeTailscale();
    const first = run(profile, tailscale, [publisher], { ids: ['probe'] });
    await first.snapshot();
    await first.main.stop();
    tailscale.mount(HTTPS_PORT, '/', 'http://127.0.0.1:3000');
    tailscale.mount(443, '/', 'http://127.0.0.1:8080');
    const next = run(profile, tailscale, [], { ids: [] });
    await next.snapshot();
    expect(tailscale.roots()).toEqual([[HTTPS_PORT, 'http://127.0.0.1:3000'], [443, 'http://127.0.0.1:8080']]);
    expect(JSON.parse(readFileSync(join(profile, 'tailnet-serve.json'), 'utf8'))).toEqual([]);
  });

  it('removes only its own mount from a port where the owner serves another path', async () => {
    const profile = tempDir();
    const tailscale = fakeTailscale();
    const first = run(profile, tailscale, [publisher], { ids: ['probe'] });
    await first.snapshot();
    await first.main.stop();
    tailscale.mount(HTTPS_PORT, '/owner', 'http://127.0.0.1:3000');
    const next = run(profile, tailscale, [], { ids: [] });
    await next.snapshot();
    expect([...tailscale.ports.get(HTTPS_PORT)!]).toEqual([['/owner', 'http://127.0.0.1:3000']]);
  });

  it('adopts config an earlier build set without recording it, while the profile has no record file', async () => {
    const profile = tempDir();
    const file = join(profile, 'tailnet-serve.json');
    const tailscale = fakeTailscale();
    tailscale.mount(HTTPS_PORT, '/', TARGET);
    const legacy = [{ pluginId: 'probe', httpsPort: HTTPS_PORT, target: TARGET }];
    await new TailnetServe(tailscale.cli, file, () => undefined, legacy).reconcile(() => false);
    expect(tailscale.ports.size).toBe(0);
    // Once the file exists, it alone says what ChattyPop set.
    tailscale.mount(HTTPS_PORT, '/', TARGET);
    await new TailnetServe(tailscale.cli, file, () => undefined, legacy).reconcile(() => false);
    expect(tailscale.root(HTTPS_PORT)).toBe(TARGET);
  });

  it('records before it publishes, so config set by a command that failed is still removed', async () => {
    const profile = tempDir();
    const tailscale = fakeTailscale();
    // The command takes effect, but the CLI reports a timeout.
    const tailnet = new TailnetServe(async (args) => {
      const out = await tailscale.cli(args);
      if (args.includes('--bg')) throw new TailnetError('Tailscale didn’t answer.');
      return out;
    }, join(profile, 'tailnet-serve.json'), () => undefined);
    await expect(tailnet.publish('probe', HTTPS_PORT, LOCAL_PORT)).rejects.toThrow('didn’t answer');
    expect(tailscale.root(HTTPS_PORT)).toBe(TARGET);
    await tailnet.withdraw('probe', HTTPS_PORT);
    expect(tailscale.ports.size).toBe(0);
    // Nothing recorded: nothing to run.
    const before = tailscale.changes.length;
    await tailnet.withdraw('probe', HTTPS_PORT);
    expect(tailscale.changes.length).toBe(before);
  });

  it('keeps the record while Tailscale can’t be reached, and removes the config once it can', async () => {
    const profile = tempDir();
    const file = join(profile, 'tailnet-serve.json');
    const tailscale = fakeTailscale();
    let reachable = true;
    const tailnet = new TailnetServe(async (args) => {
      if (!reachable) throw new TailnetError('Tailscale isn’t installed on this PC.');
      return tailscale.cli(args);
    }, file, () => undefined);
    await tailnet.publish('probe', HTTPS_PORT, LOCAL_PORT);
    reachable = false;
    await tailnet.reconcile(() => false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
    reachable = true;
    await tailnet.reconcile(() => false);
    expect(tailscale.ports.size).toBe(0);
    expect(existsSync(file) && JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('refuses a plugin that doesn’t declare network.tailnet', async () => {
    const tailscale = fakeTailscale();
    let refused: unknown = null;
    const undeclared = defineMainPlugin(definePlugin({ manifest: { id: 'other', name: 'Other', version: '1', description: '' } }), (ctx) =>
      ctx.whileActive(() => ctx.net.tailnet.publish(LOCAL_PORT).then(() => undefined, (err: unknown) => void (refused = err))),
    );
    const app = run(tempDir(), tailscale, [undeclared as unknown as typeof publisher], { ids: ['other'] });
    await app.snapshot();
    await vi.waitFor(() => expect(String(refused)).toMatch(/does not declare network.tailnet/));
    expect(tailscale.ports.size).toBe(0);
  });
});

describe('the Tailscale CLI’s output', () => {
  it('finds the enable link Tailscale prints while Serve is off for the tailnet', () => {
    const out = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n';
    expect(serveEnableUrl(out)).toBe('https://login.tailscale.com/f/serve?node=abc123');
    expect(serveEnableUrl('Available within your tailnet:')).toBeNull();
  });

  it('reads this machine’s tailnet name only while connected', () => {
    expect(tailnetName(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.' } }))).toBe('pc.tail1.ts.net');
    expect(tailnetName(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'pc.tail1.ts.net.' } }))).toBeNull();
    expect(tailnetName('not json')).toBeNull();
  });

  it('reads where a port’s root proxies to, from `tailscale serve status --json`', () => {
    const status = JSON.stringify({ TCP: { '8443': { HTTPS: true } }, Web: { 'pc.tail1.ts.net:8443': { Handlers: { '/': { Proxy: TARGET } } } } });
    expect(rootProxies(status, HTTPS_PORT)).toEqual([TARGET]);
    expect(rootProxies(status, 443)).toEqual([]);
    expect(rootProxies('{}', HTTPS_PORT)).toEqual([]);
    expect(rootProxies('', HTTPS_PORT)).toEqual([]);
  });
});
