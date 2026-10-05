// Marketplace client: local and source installs, uninstall and cancel, and the installed list state() reports.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { INSTALLED_PLUGINS_DIR, REMOVED_DIR, STAGED_DIR } from '@shared/installedPlugins';
import type { BuildPlugin } from '../src/main/marketplace/marketplaces';
import { InstalledFolder } from '../src/main/marketplace/staging';
import { tempDir } from './helpers';
import { API, COMMIT, DOWNLOAD, REPO, builtFiles, filesToTar, fixture, tarGz, writeFiles } from './marketplaceHarness';

const at = (profile: string, ...parts: string[]): string => join(profile, INSTALLED_PLUGINS_DIR, ...parts);
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
/** Writes `demo` at `version` into installed-plugins/<id>, as the boot leaves an applied install. */
const installed = (profile: string, version = '0.9.0'): string => writeFiles(at(profile, 'demo'), builtFiles('demo', version));

describe('local installs', () => {
  it('stages a built folder by copying it, recording its path', async () => {
    const f = fixture();
    const dir = writeFiles(tempDir(), builtFiles());
    await f.make().installLocal(dir);
    expect(json(at(f.profile, STAGED_DIR, 'demo', 'source.json'))).toEqual({ kind: 'local', path: dir, installedAt: 1 });
    expect(existsSync(join(dir, 'plugin.json'))).toBe(true);
    expect(existsSync(join(dir, 'source.json'))).toBe(false);
  });

  it('stages a .tar.gz', async () => {
    const f = fixture();
    const file = join(tempDir(), 'demo.tar.gz');
    writeFileSync(file, tarGz(filesToTar(builtFiles())));
    await f.make().installLocal(file);
    expect(json(at(f.profile, STAGED_DIR, 'demo', 'plugin.json'))['id']).toBe('demo');
  });

  it('refuses a folder missing an entry file its manifest names, and a relative path', async () => {
    const f = fixture();
    const { 'browser/shared.js': _, ...partial } = builtFiles();
    await expect(f.make().installLocal(writeFiles(tempDir(), partial))).rejects.toThrow(/names browser\/shared.js, which the build lacks/);
    await expect(f.make().installLocal('relative/dir')).rejects.toThrow(/doesn't exist/);
    expect(existsSync(at(f.profile, STAGED_DIR, 'demo'))).toBe(false);
  });
});

describe('source installs', () => {
  it('builds the plugin folder of the tarball at the branch head and records the commit', async () => {
    const f = fixture();
    const built: string[] = [];
    const build: BuildPlugin = async (pluginDir, outDir) => {
      built.push(readFileSync(join(pluginDir, 'src.ts'), 'utf8'));
      writeFiles(outDir, builtFiles());
      return json(join(outDir, 'plugin.json')) as never;
    };
    const m = f.make(build);
    await m.add(REPO, null);
    await m.install(REPO, 'demo', { kind: 'source' });
    expect(built).toEqual(['x']);
    expect(json(at(f.profile, STAGED_DIR, 'demo', 'source.json'))).toEqual({ kind: 'source', repo: REPO, branch: 'main', commit: COMMIT, installedAt: 1 });
  });

  it('installs from source a plugin the index gives no source: its plugins/<id> folder on the default branch', async () => {
    const f = fixture();
    const { source: _, ...plain } = f.index.plugins[0]!;
    f.gh.json(`${API}/repos/${REPO}`, { default_branch: 'trunk' });
    f.gh.json(`https://raw.githubusercontent.com/${REPO}/trunk/marketplace.json`, { ...f.index, plugins: [plain] });
    f.gh.json(`${API}/repos/${REPO}/commits/trunk`, { sha: COMMIT });
    const built: string[] = [];
    const m = f.make(async (pluginDir, outDir) => {
      built.push(readFileSync(join(pluginDir, 'src.ts'), 'utf8'));
      return json(join(writeFiles(outDir, builtFiles()), 'plugin.json')) as never;
    });
    await m.add(REPO, null);
    expect((await m.state()).marketplaces[0]!.plugins[0]!.source).toEqual({ path: 'plugins/demo', branch: 'trunk' });
    await m.install(REPO, 'demo', { kind: 'source' });
    expect(built).toEqual(['x']);
    expect(json(at(f.profile, STAGED_DIR, 'demo', 'source.json'))).toMatchObject({ kind: 'source', branch: 'trunk', commit: COMMIT });
  });

  it('refuses a build of another plugin', async () => {
    const f = fixture();
    const m = f.make(async (_dir, out) => json(join(writeFiles(out, builtFiles('other')), 'plugin.json')) as never);
    await m.add(REPO, null);
    await expect(m.install(REPO, 'demo', { kind: 'source' })).rejects.toThrow(/plugin other, not demo/);
  });

  it('is refused clearly, before any request, while the build is not wired', async () => {
    const f = fixture();
    const m = f.make(null);
    await m.add(REPO, null);
    const calls = f.gh.calls.length;
    await expect(m.install(REPO, 'demo', { kind: 'source' })).rejects.toThrow(/not available yet/);
    expect(f.gh.calls.length).toBe(calls);
  });
});

describe('uninstall, cancel and state()', () => {
  it('reports installed, staged and removal-marked plugins', async () => {
    const f = fixture();
    const m = f.make();
    installed(f.profile);
    expect((await m.state()).installed).toEqual([{ id: 'demo', name: 'Plugin demo', version: '0.9.0', source: null, pending: null }]);
    await m.add(REPO, null);
    await m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    const [update] = (await m.state()).installed;
    expect(update).toMatchObject({ version: '0.9.0', pending: { kind: 'install', version: '1.0.0', source: { kind: 'release', tag: 'demo-v1.0.0' } } });
    await m.uninstall('demo');
    expect((await m.state()).installed[0]!.pending).toEqual({ kind: 'remove' });
  });

  it('reports a staged copy beside a removal marker as the install the boot applies', async () => {
    const f = fixture();
    installed(f.profile);
    writeFiles(at(f.profile, STAGED_DIR, 'demo'), { ...builtFiles(), 'source.json': JSON.stringify({ kind: 'local', path: '/p', installedAt: 1 }) });
    writeFiles(at(f.profile, REMOVED_DIR), { demo: '' });
    expect((await f.make().state()).installed[0]!.pending).toEqual({ kind: 'install', version: '1.0.0', source: { kind: 'local', path: '/p', installedAt: 1 } });
  });

  it('uninstall drops a staged update and marks an installed plugin for removal', async () => {
    const f = fixture();
    const m = f.make();
    installed(f.profile);
    writeFiles(at(f.profile, STAGED_DIR, 'demo'), builtFiles());
    await m.uninstall('demo');
    expect(existsSync(at(f.profile, STAGED_DIR, 'demo'))).toBe(false);
    expect(existsSync(at(f.profile, REMOVED_DIR, 'demo'))).toBe(true);
  });

  it('uninstall of a staged-only plugin drops it without a marker', async () => {
    const f = fixture();
    const m = f.make();
    writeFiles(at(f.profile, STAGED_DIR, 'demo'), builtFiles());
    await m.uninstall('demo');
    expect(existsSync(at(f.profile, STAGED_DIR, 'demo'))).toBe(false);
    expect(existsSync(at(f.profile, REMOVED_DIR, 'demo'))).toBe(false);
    expect((await m.state()).installed).toEqual([]);
    await expect(m.uninstall('demo')).rejects.toThrow(/isn't installed/);
  });

  it('cancel drops a staged update and a removal marker, leaving the plugin as it runs', async () => {
    const f = fixture();
    const m = f.make();
    installed(f.profile);
    writeFiles(at(f.profile, STAGED_DIR, 'demo'), builtFiles());
    await m.cancel('demo');
    expect(existsSync(at(f.profile, STAGED_DIR, 'demo'))).toBe(false);
    await m.uninstall('demo');
    await m.cancel('demo');
    expect(existsSync(at(f.profile, REMOVED_DIR, 'demo'))).toBe(false);
    expect((await m.state()).installed).toEqual([expect.objectContaining({ version: '0.9.0', pending: null })]);
  });

  it('refuses an id that is not a plugin id', async () => {
    const m = fixture().make();
    await expect(m.uninstall('../x')).rejects.toThrow(/not a plugin id/);
    await expect(m.cancel('..')).rejects.toThrow(/not a plugin id/);
  });
});

/** Every file under `dir` with its content, by relative path. */
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).map((p) => [p, readFileSync(join(dir, p), 'utf8')]),
  );

describe('a failed swap and concurrent operations', () => {
  it('puts the older staged copy back when renaming the new build in fails, changing nothing', () => {
    const f = fixture();
    const root = at(f.profile);
    installed(f.profile);
    writeFiles(at(f.profile, STAGED_DIR, 'demo'), { ...builtFiles('demo', '0.9.5'), 'source.json': JSON.stringify({ kind: 'local', path: '/old', installedAt: 0 }) });
    writeFiles(at(f.profile, REMOVED_DIR), { demo: '' });
    const before = snapshot(root);
    const fresh = writeFiles(tempDir(), builtFiles());
    const folder = new InstalledFolder(root, () => undefined, (from, to) => {
      if (from === fresh) throw new Error('EPERM: operation not permitted');
      renameSync(from, to);
    });
    expect(() => folder.stage(fresh, { id: 'demo' }, { kind: 'local', path: fresh, installedAt: 1 })).toThrow(/EPERM/);
    expect(snapshot(root)).toEqual(before);
  });

  /** Holds the first asset download until the returned release is called. */
  function gateFirstDownload(f: ReturnType<typeof fixture>): { hits: () => number; release: () => void } {
    const url = `${DOWNLOAD}/demo-v1.0.0/demo.tar.gz`;
    const route = f.gh.routes.get(url)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hits = 0;
    f.gh.routes.set(url, async () => {
      if (++hits === 1) await gate;
      return route();
    });
    return { hits: () => hits, release };
  }
  const indexCalls = (f: ReturnType<typeof fixture>): number => f.gh.calls.filter((c) => c.url.endsWith('/marketplace.json')).length;

  it('runs a second install of one id only after the first ends', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    const gate = gateFirstDownload(f);
    const first = m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    const second = m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    await vi.waitFor(() => expect(gate.hits()).toBe(1));
    expect(indexCalls(f)).toBe(2); // add, then the first install; the second hasn't started.
    gate.release();
    await Promise.all([first, second]);
    expect(indexCalls(f)).toBe(3);
    expect(json(at(f.profile, STAGED_DIR, 'demo', 'plugin.json'))['version']).toBe('1.0.0');
  });

  it('runs a cancel issued during an install after it, so the install ends up dropped', async () => {
    const f = fixture();
    const m = f.make();
    await m.add(REPO, null);
    const gate = gateFirstDownload(f);
    const install = m.install(REPO, 'demo', { kind: 'release', version: '1.0.0' });
    const cancel = m.cancel('demo');
    await vi.waitFor(() => expect(gate.hits()).toBe(1));
    gate.release();
    await Promise.all([install, cancel]);
    expect(existsSync(at(f.profile, STAGED_DIR, 'demo'))).toBe(false);
  });
});
