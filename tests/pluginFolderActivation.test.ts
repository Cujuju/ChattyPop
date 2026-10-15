// A folder plugin switched off or reloaded while its asynchronous activate is still running: the retired activation's
// resource is torn down once it returns, and overlapping reloads leave one listing of each plugin. The archive closing
// retires it the same way and stops the folder pass.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { PluginHost } from '../src/core/plugins/host';
import { tempDb, tempDir } from './helpers';

/** What the plugin's activations reach: each one starts a resource, then waits for the test to release it. */
interface Gate {
  live: number;
  disposals: number;
  started: number;
  release: () => void;
  opened: Promise<void>;
}
const gate = (): Gate => {
  const g = { live: 0, disposals: 0, started: 0 } as Gate;
  g.opened = new Promise<void>((open) => (g.release = open));
  return g;
};
const MAIN = `
export async function activate() {
  const g = globalThis.folderGate;
  g.live++;
  g.started++;
  await g.opened;
  return () => { g.live--; g.disposals++; };
}`;

let dir: string;
let host: PluginHost;
let db: ReturnType<typeof tempDb>;
const hold = globalThis as typeof globalThis & { folderGate?: Gate };
const until = async (done: () => boolean): Promise<void> => {
  while (!done()) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  dir = tempDir();
  mkdirSync(join(dir, 'slow'), { recursive: true });
  writeFileSync(join(dir, 'slow', 'plugin.json'), JSON.stringify({ id: 'slow', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
  writeFileSync(join(dir, 'slow', 'main.mjs'), MAIN);
  hold.folderGate = gate();
  db = tempDb();
  host = new PluginHost(dir, { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null });
});
afterEach(() => void delete hold.folderGate);

describe('a folder activation still running', () => {
  it('switched off: its resource is torn down once it returns, and it stays off', async () => {
    const g = hold.folderGate!;
    const loading = host.loadAll();
    await until(() => g.started === 1);
    await host.setEnabled('slow', false);
    g.release();
    await loading;
    expect(host.list().map((p) => [p.id, p.status])).toEqual([['slow', 'disabled']]);
    expect([g.live, g.disposals]).toEqual([0, 1]);
  });

  it('when the archive closes: its resource is torn down once it returns, and no later folder loads', async () => {
    mkdirSync(join(dir, 'tail'), { recursive: true });
    writeFileSync(join(dir, 'tail', 'plugin.json'), JSON.stringify({ id: 'tail', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
    writeFileSync(join(dir, 'tail', 'main.mjs'), MAIN);
    const g = hold.folderGate!;
    const loading = host.loadAll();
    await until(() => g.started === 1);
    host.endActivations();
    db.close();
    g.release();
    await loading;
    expect(host.list().map((p) => [p.id, p.status])).toEqual([['slow', 'disabled']]);
    expect([g.started, g.live, g.disposals]).toEqual([1, 0, 1]);
  });

  it('reloaded twice over: one activation stays live, every retired one is torn down, one listing', async () => {
    const g = hold.folderGate!;
    const loading = host.loadAll();
    await until(() => g.started === 1);
    const first = host.reload();
    await until(() => g.started === 2);
    const second = host.reload();
    await until(() => g.started === 3);
    g.release();
    await Promise.all([loading, first, second]);
    expect(host.list().map((p) => [p.key, p.status])).toEqual([['slow', 'active']]);
    expect([g.live, g.disposals]).toEqual([1, 2]);
    await host.setEnabled('slow', false);
    expect([g.live, g.disposals]).toEqual([0, 3]);
  });
});
