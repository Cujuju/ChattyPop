// Marketplaces (docs/plugin-architecture.md §16): the added repos and their tokens, their listings as last fetched, and
// installs staged for the next start. No Electron here: the profile, secrets, fetch and build are injected.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type InstallChoice, type MarketplaceApi, type MarketplaceListing, type MarketplacePlugin, type MarketplaceState } from '@shared/marketplace';
import { INSTALLED_PLUGINS_DIR, REPO_PATTERN, sdkMismatch, type InstalledManifest } from '@shared/installedPlugins';
import { errorMessage } from '@shared/errors';
import { extractTarGz } from './archive';
import { GitHub, type FetchFn } from './github';
import { InstallHistory } from './history';
import { InstalledFolder, checkBuild } from './staging';

/** Builds a plugin source folder into `outDir` (built output, plugin.json included). */
export type BuildPlugin = (pluginDir: string, outDir: string) => Promise<InstalledManifest>;

export interface SecretStore {
  read(file: string): string | null;
  write(file: string, value: string): void;
  delete(file: string): void;
}

export interface MarketplaceDeps {
  profileDir: string;
  secrets: SecretStore;
  fetch: FetchFn;
  /** Null until the source build is wired; source installs are refused meanwhile. */
  build: BuildPlugin | null;
  /** Listed before the added ones and never stored (BUILT_IN_MARKETPLACES in the app). */
  builtIn: readonly string[];
  /** A leftover work folder that couldn't be deleted; reported, never failing the install. */
  leftoverFailed: (path: string, err: unknown) => void;
  now?: () => number;
}

/** Profile file of the added marketplaces: `{ repos: string[] }`. Tokens live in secrets; built-in ones aren't stored. */
export const MARKETPLACES_FILE = 'marketplaces.json';
const ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz'];
/** GitHub's token alphabet (ghp_…, github_pat_…): nothing stored can break, or be quoted by, a header check. */
const TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;
const checkToken = (token: string | null): void => {
  if (token !== null && !TOKEN_PATTERN.test(token)) throw new Error('A GitHub token holds only letters, digits and underscores.');
};

/** Secret file of a repo's token. `.` can't appear in a plugin id, so it never names a plugin's secret (`<id>-<name>`). */
export const tokenFile = (repo: string): string => `marketplace.${repo.toLowerCase().replace('/', '+')}.token`;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class Marketplaces implements MarketplaceApi {
  private readonly github: GitHub;
  private readonly folder: InstalledFolder;
  private readonly history: InstallHistory;
  private readonly listings = new Map<string, MarketplaceListing>();
  private readonly now: () => number;
  /** Per plugin id: the last queued mutation, settled. A mutation starts once the one before it on that id ends. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: MarketplaceDeps) {
    this.github = new GitHub(deps.fetch);
    this.folder = new InstalledFolder(join(deps.profileDir, INSTALLED_PLUGINS_DIR), deps.leftoverFailed);
    this.folder.clearIncoming();
    this.history = new InstallHistory(deps.profileDir);
    this.now = deps.now ?? Date.now;
  }

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return run;
  }

  /** The repos the owner added, as stored. */
  private stored(): string[] {
    const file = join(this.deps.profileDir, MARKETPLACES_FILE);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { repos?: unknown };
    return Array.isArray(raw.repos) ? raw.repos.filter((r): r is string => typeof r === 'string' && REPO_PATTERN.test(r)) : [];
  }

  private isBuiltIn(repo: string): boolean {
    return this.deps.builtIn.some((r) => sameRepo(r, repo));
  }

  /** Every listed repo: the built-in ones, then the added ones (one added before it became built in shows once). */
  private repos(): string[] {
    return [...this.deps.builtIn, ...this.stored().filter((r) => !this.isBuiltIn(r))];
  }

  private saveRepos(repos: string[]): void {
    writeFileSync(join(this.deps.profileDir, MARKETPLACES_FILE), JSON.stringify({ repos }, null, 2));
  }

  /** The listed repo's spelling (GitHub names are case-insensitive); throws when it isn't listed. */
  private added(repo: string): string {
    const found = this.repos().find((r) => sameRepo(r, repo));
    if (!found) throw new Error(`${repo} isn't an added marketplace.`);
    return found;
  }

  /** An added repo's spelling; throws for a built-in one, which has no token and can't be removed. */
  private ownerAdded(repo: string, why: string): string {
    const found = this.added(repo);
    if (this.isBuiltIn(found)) throw new Error(`${found} is built in: ${why}`);
    return found;
  }

  private token(repo: string): string | null {
    return this.deps.secrets.read(tokenFile(repo));
  }

  private hasToken(repo: string): boolean {
    try {
      return this.token(repo) !== null;
    } catch {
      return true; // Stored but unreadable (another account's keystore): still stored.
    }
  }

  private async fetchListing(repo: string): Promise<MarketplaceListing> {
    let listing: MarketplaceListing;
    try {
      const index = await this.github.index(repo, this.token(repo));
      listing = { repo, hasToken: this.hasToken(repo), builtIn: this.isBuiltIn(repo), plugins: index.plugins, error: null, fetchedAt: this.now() };
    } catch (err) {
      listing = { repo, hasToken: this.hasToken(repo), builtIn: this.isBuiltIn(repo), plugins: [], error: errorMessage(err), fetchedAt: this.now() };
    }
    this.listings.set(repo, listing);
    return listing;
  }

  async state(): Promise<MarketplaceState> {
    const marketplaces = this.repos().map((repo) => ({
      ...(this.listings.get(repo) ?? { plugins: [], error: null, fetchedAt: null }),
      repo,
      hasToken: this.hasToken(repo),
      builtIn: this.isBuiltIn(repo),
    }));
    return { marketplaces, installed: this.folder.entries(), history: this.history.read() };
  }

  async add(repo: string, token: string | null): Promise<void> {
    if (!REPO_PATTERN.test(repo)) throw new Error(`"${repo}" isn't a GitHub repo like owner/name.`);
    checkToken(token);
    if (this.isBuiltIn(repo)) throw new Error(`${repo} is built in: it is always listed.`);
    const isAdded = (): boolean => this.stored().some((r) => sameRepo(r, repo));
    if (isAdded()) throw new Error(`${repo} is already added.`);
    const index = await this.github.index(repo, token);
    if (isAdded()) throw new Error(`${repo} is already added.`); // Again: another add may have finished meanwhile.
    if (token !== null) this.deps.secrets.write(tokenFile(repo), token);
    this.saveRepos([...this.stored(), repo]);
    this.listings.set(repo, { repo, hasToken: token !== null, builtIn: false, plugins: index.plugins, error: null, fetchedAt: this.now() });
  }

  async remove(repo: string): Promise<void> {
    const found = this.ownerAdded(repo, 'it is always listed.');
    this.saveRepos(this.stored().filter((r) => r !== found));
    this.deps.secrets.delete(tokenFile(found));
    this.listings.delete(found);
  }

  async setToken(repo: string, token: string | null): Promise<void> {
    const found = this.ownerAdded(repo, 'it is public and needs no token.');
    checkToken(token);
    if (token === null) this.deps.secrets.delete(tokenFile(found));
    else this.deps.secrets.write(tokenFile(found), token);
    await this.fetchListing(found);
  }

  async refresh(): Promise<void> {
    await Promise.all(this.repos().map((repo) => this.fetchListing(repo)));
  }

  async install(repo: string, pluginId: string, choice: InstallChoice): Promise<void> {
    const found = this.added(repo);
    if (choice.kind === 'source' && !this.deps.build) throw new Error('Installing from source is not available yet; install a release.');
    await this.exclusive(pluginId, async () => {
      const listing = await this.fetchListing(found);
      if (listing.error) throw new Error(listing.error);
      const plugin = listing.plugins.find((p) => p.id === pluginId);
      if (!plugin) throw new Error(`${found} doesn't list ${pluginId}.`);
      await (choice.kind === 'release' ? this.installRelease(found, plugin, choice.version) : this.installSource(found, plugin));
    });
  }

  private async installRelease(repo: string, plugin: MarketplacePlugin, version: string): Promise<void> {
    const release = plugin.releases.find((r) => r.version === version);
    if (!release) throw new Error(`${repo} lists no ${plugin.id} ${version}.`);
    const mismatch = sdkMismatch(release.sdk);
    if (mismatch) throw new Error(`${plugin.id} ${version}: ${mismatch}`);
    const token = this.token(repo);
    const data = await this.github.releaseAsset(repo, release.tag, release.asset, token);
    if (sha256(data) !== release.sha256) throw new Error(`${plugin.id} ${version}: the download doesn't match the sha256 in ${repo}'s index, so it was refused.`);
    await this.inWorkDir(async (work) => {
      const dir = await this.unpack(data, work);
      const fresh = !this.pending(plugin.id);
      this.folder.stage(dir, { id: plugin.id, version }, { kind: 'release', repo, tag: release.tag, sha256: release.sha256, installedAt: this.now() });
      this.history.installed(plugin.id, repo, fresh);
    });
  }

  private async installSource(repo: string, plugin: MarketplacePlugin): Promise<void> {
    const build = this.deps.build;
    if (!build) throw new Error('Installing from source is not available yet; install a release.');
    if (!plugin.source) throw new Error(`${repo} lists no source for ${plugin.id}.`);
    const { path, branch } = plugin.source;
    const token = this.token(repo);
    const commit = await this.github.latestCommit(repo, branch, token);
    const data = await this.github.downloadTarball(repo, commit, token);
    await this.inWorkDir(async (work) => {
      const tree = await this.unpack(data, work);
      const tops = readdirDirs(tree);
      if (tops.length !== 1) throw new Error(`${repo}'s tarball should hold one folder, not ${tops.length}.`);
      const top = join(tree, tops[0]!);
      const pluginDir = resolve(top, path);
      if (!isInside(top, pluginDir) || !existsSync(pluginDir)) throw new Error(`${repo} at ${commit.slice(0, 7)} has no folder ${path}.`);
      const out = join(work, 'out');
      mkdirSync(out);
      await build(pluginDir, out);
      const fresh = !this.pending(plugin.id);
      this.folder.stage(out, { id: plugin.id }, { kind: 'source', repo, branch, commit, installedAt: this.now() });
      this.history.installed(plugin.id, repo, fresh);
    });
  }

  /** Its id is known only once unpacked, so only the staging step waits its turn. */
  async installLocal(path: string): Promise<void> {
    if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${path} doesn't exist.`);
    await this.inWorkDir(async (work) => {
      let dir: string;
      if (statSync(path).isDirectory()) {
        checkBuild(path, null); // Refuse before copying a folder that isn't a build.
        dir = join(work, 'plugin');
        cpSync(path, dir, { recursive: true, dereference: true });
      } else if (ARCHIVE_SUFFIXES.some((s) => path.toLowerCase().endsWith(s))) {
        dir = await this.unpack(readFileSync(path), work);
      } else {
        throw new Error(`${path} is neither a built plugin folder nor a ${ARCHIVE_SUFFIXES.join(' or ')} file.`);
      }
      const { id } = checkBuild(dir, null);
      await this.exclusive(id, async () => {
        const fresh = !this.pending(id);
        this.folder.stage(dir, null, { kind: 'local', path, installedAt: this.now() });
        this.history.installed(id, null, fresh);
      });
    });
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.exclusive(pluginId, async () => {
      const entry = this.folder.entries().find((e) => e.id === pluginId);
      this.folder.uninstall(pluginId);
      this.history.uninstalled(pluginId, entry?.source && entry.source.kind !== 'local' ? entry.source.repo : null, !entry?.pending);
    });
  }

  async cancel(pluginId: string): Promise<void> {
    await this.exclusive(pluginId, async () => {
      const staged = this.pending(pluginId);
      this.folder.cancel(pluginId);
      if (staged) this.history.cancelled(pluginId);
    });
  }

  /** Whether a change of `id` is staged for the next start. */
  private pending(id: string): boolean {
    return this.folder.entries().some((e) => e.id === id && e.pending !== null);
  }

  /** Runs `fn` with a fresh work folder under installed-plugins, deleted afterwards whatever happens. */
  private async inWorkDir(fn: (work: string) => Promise<void>): Promise<void> {
    const work = this.folder.workDir();
    try {
      await fn(work);
    } finally {
      this.folder.removeLeftover(work);
    }
  }

  /** Writes `data` (.tar.gz) into `work` and unpacks it to `work/unpacked`, returned. */
  private async unpack(data: Buffer, work: string): Promise<string> {
    const archive = join(work, 'archive.tar.gz');
    writeFileSync(archive, data);
    const dir = join(work, 'unpacked');
    await extractTarGz(archive, dir);
    return dir;
  }
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const readdirDirs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
