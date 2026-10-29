// Plugin activation and disposal; PluginDispatch runs the active ones.
import { createArchiveRefViews } from './archiveRefs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@shared/errors';
import { PLUGIN_API_VERSION, PLUGIN_STOP_DEADLINE_MS } from '@shared/plugins';
import type { InstalledFailure } from '@shared/installedCheck';
import type { InstalledStart } from '@shared/installedPlugins';
import { getSetting, setSetting } from '../db';
import { emptyRegistrations, type HostDeps } from './api';
import { nestedTablesError, tableNamespacesNest, type PluginDescriptor } from '@shared/bundledTypes';
import type { HostPlugins } from './bundled';
import { CompletionLedger } from './completions';
import { createCoreContext, type CorePlugin } from './context';
import { PluginDispatch } from './dispatch';
import { loadFolderPlugin, type FolderHost } from './folderPlugins';
import { unload, type BundledEntry, type Loaded } from './loaded';
import { assertRegistered } from './registrationCheck';
import { ActivationContinuity } from './continuity';
import { reservePluginId } from './tableOwners';

/** Ids of plugins the user turned off (Settings → Plugins). */
export const PLUGINS_DISABLED_KEY = 'plugins.disabled';

/** Installed plugins as this process has them (§16): main's start, and accepted ones whose node modules failed here. */
export interface InstalledPlugins {
  start: InstalledStart;
  failed: readonly InstalledFailure[];
}
const NO_INSTALLED: InstalledPlugins = { start: { accepted: [], refused: [] }, failed: [] };

/**
 * Loads the bundled plugins this build includes, then plugins from <plugins dir>/<folder>/plugin.json; dispatches hooks
 * to them and isolates their failures. Both kinds share on/off (Settings → Plugins) and error reporting.
 */
export class PluginHost extends PluginDispatch {
  /** Bumped on every folder pass, so the ESM loader re-reads changed entry files and an older pass stops. */
  private generation = 0;
  private bundledStarted = false;
  /** Set once the archive begins closing: nothing loads after. */
  private ended = false;
  /** Folder loads under way: each settles once its activation returned and, if retired meanwhile, its cleanup ran. */
  private readonly loading = new Set<Promise<void>>();
  /** Every bundled plugin, in build order; each has an on/off switch whether or not it has a core side. */
  private readonly bundled: readonly BundledEntry[];
  private readonly continuity: ActivationContinuity;
  /** Each bundled plugin's completion reports, kept for the core process across its activations. */
  private readonly ledgers = new Map<string, CompletionLedger>();
  /** Installed plugins' folders by id: the descriptors main's start accepted. */
  private readonly installedDirs: ReadonlyMap<string, string>;
  /** Why an accepted installed plugin's modules failed to load in core, by id. */
  private readonly failedHere: ReadonlyMap<string, string>;

  constructor(
    private readonly dir: string,
    deps: HostDeps,
    core: readonly CorePlugin[] = [],
    /** This build's descriptors, then accepted installed ones (BUNDLED_PLUGINS); defaults to the core entries' own. */
    descriptors: readonly PluginDescriptor[] = core.map((c) => c.plugin),
    private readonly installed: InstalledPlugins = NO_INSTALLED,
  ) {
    super(deps);
    this.installedDirs = new Map(installed.start.accepted.map((p) => [p.manifest.id, p.dir]));
    this.failedHere = new Map(installed.failed.map((f) => [f.id, f.error]));
    const byId = new Map(core.map((c) => [c.plugin.manifest.id, c]));
    this.bundled = descriptors.map((plugin) => ({ plugin, core: byId.get(plugin.manifest.id) ?? null }));
    const unlisted = core.filter((c) => !descriptors.some((d) => d.manifest.id === c.plugin.manifest.id));
    if (unlisted.length) throw new Error(`Core entries without a bundled descriptor: ${unlisted.map((c) => c.plugin.manifest.id).join(', ')}`);
    // checkBundled and acceptInstalled keep nesting ids out of a build's descriptors; a host given them otherwise refuses.
    for (const d of descriptors) {
      const nesting = descriptors.find((other) => tableNamespacesNest(d.manifest.id, other.manifest.id));
      if (nesting) throw nestedTablesError(d.manifest.id, nesting.manifest.id);
    }
    this.continuity = new ActivationContinuity(() => deps.db);
    deps.bundled?.providers.bindPlugins((id) => this.state(id));
    deps.bundled?.rules.bindPlugins((id) => this.state(id));
  }

  /** Starts the bundled plugins that are on, synchronously: core init calls it before the Jev catch-up. Once. */
  startBundled(): void {
    if (this.bundledStarted) return;
    this.bundledStarted = true;
    const disabled = this.disabled();
    this.continuity.start(new Set(this.bundled.map((b) => b.plugin.manifest.id)));
    for (const entry of this.bundled) this.loadBundled(entry, disabled, this.continuity.resumed(entry.plugin.manifest.id));
    this.listUnloaded();
    this.deps.bundled?.rules.changed();
    this.deps.bundled?.catchUp(); // after every registration, so their questions ride in it
  }

  /** Starts bundled plugins (unless started already), then loads the plugins folder. */
  async loadAll(): Promise<void> {
    this.startBundled();
    await this.loadFolders(this.disabled());
    this.deps.emit({ type: 'plugins-changed' });
  }

  /**
   * Settings → Plugins → Reload: re-reads the plugins folder. Bundled plugins are compiled in, so they stay loaded
   * with their session state (posts in flight, cooldowns, answered commands).
   */
  async reload(): Promise<void> {
    for (const [key, p] of this.plugins) {
      if (p.origin !== 'folder') continue;
      unload(p);
      this.plugins.delete(key);
    }
    await this.loadFolders(this.disabled());
    this.deps.emit({ type: 'plugins-changed' });
  }

  /** A bundled plugin's switch loads or unloads that plugin alone; a folder plugin's reloads the plugins folder. */
  async setEnabled(id: string, on: boolean): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry && entry.manifest.id !== id) return;
    const disabled = this.disabled();
    if (on) disabled.delete(id);
    else disabled.add(id);
    setSetting(this.deps.db, PLUGINS_DISABLED_KEY, [...disabled]);
    const p = this.plugins.get(id);
    if (!p || p.origin === 'folder') return this.reload();
    // Refused or failed at start: nothing loaded to switch; the setting applies at a start that loads it.
    if (!p.entry) return void this.deps.emit({ type: 'plugins-changed' });
    const activated = on && p.status !== 'active';
    if (activated) this.loadBundled(p.entry, disabled, false);
    if (!on) {
      this.continuity.deactivated(id);
      // Off before its registrations go, so what they revoke says why.
      p.status = 'disabled';
      p.error = null;
      unload(p);
    }
    this.deps.bundled?.rules.changed();
    // What arrived while it was off: its questions are registered and its rules compiled again.
    if (activated && this.plugins.get(id)?.status === 'active') this.deps.bundled?.catchUp();
    this.deps.emit({ type: 'rules-changed' });
    this.deps.emit({ type: 'plugins-changed' });
  }

  /**
   * Ends activations before archive closure without changing switches or continuity, and stops the folder pass. Ones
   * still running are retired now; resolves once they returned and their cleanup ran, or at `deadlineMs`. The app restarts afterward.
   */
  async endActivations(deadlineMs = PLUGIN_STOP_DEADLINE_MS): Promise<void> {
    this.ended = true;
    this.generation++;
    for (const p of this.plugins.values()) if (!p.retired) unload(p);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overrun = new Promise<'overrun'>((settle) => (timer = setTimeout(() => settle('overrun'), deadlineMs)));
    const outcome = await Promise.race([Promise.allSettled([...this.loading]).then(() => 'ended' as const), overrun]);
    clearTimeout(timer);
    if (outcome === 'overrun') console.error(`[plugins] activations still running after ${deadlineMs} ms; their cleanup runs after the archive closes`);
  }

  private disabled(): Set<string> {
    return new Set((getSetting(this.deps.db, PLUGINS_DISABLED_KEY) as string[] | undefined) ?? []);
  }

  /** Loads the plugins folder; a later pass (a reload) supersedes this one, which then loads nothing more. */
  private async loadFolders(disabled: Set<string>): Promise<void> {
    const generation = ++this.generation;
    if (this.ended || !existsSync(this.dir)) return;
    const host: FolderHost = { plugins: this.plugins, deps: this.deps, guard: (p, fn) => this.guard(p, fn) };
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (generation !== this.generation) return;
      if (!entry.isDirectory()) continue;
      const load = loadFolderPlugin(join(this.dir, entry.name), disabled, generation, host);
      this.loading.add(load);
      await load.finally(() => this.loading.delete(load));
    }
  }

  /** Lists installed plugins refused by main or failing core descriptor load. Conflicting ids receive separate diagnostic keys. */
  private listUnloaded(): void {
    const listed = new Set(this.bundled.map((b) => b.plugin.manifest.id));
    const failed = this.installed.start.accepted
      .filter((p) => this.failedHere.has(p.manifest.id) && !listed.has(p.manifest.id))
      .map((p) => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, error: this.failedHere.get(p.manifest.id)!, dir: p.dir }));
    for (const r of [...this.installed.start.refused.map((r) => ({ ...r, dir: '' })), ...failed]) {
      const loaded: Loaded = { manifest: { id: r.id, name: r.name, version: r.version, apiVersion: '?', main: '' }, dir: r.dir, origin: 'installed', entry: null, status: 'error', error: r.error, reg: emptyRegistrations() };
      this.plugins.set(this.plugins.has(r.id) ? `${r.id}@installed` : r.id, loaded);
    }
  }

  /** `resumed`: it was on through the end of the previous core session (ActivationContinuity). */
  private loadBundled(entry: BundledEntry, disabled: Set<string>, resumed: boolean): void {
    const { manifest } = entry.plugin;
    const installedDir = this.installedDirs.get(manifest.id);
    const p: Loaded = {
      manifest: { ...manifest, apiVersion: PLUGIN_API_VERSION, main: '' },
      dir: installedDir ?? '',
      origin: installedDir === undefined ? 'bundled' : 'installed',
      entry,
      status: 'disabled',
      error: null,
      reg: emptyRegistrations(),
    };
    this.plugins.set(manifest.id, p);
    if (this.ended || disabled.has(manifest.id)) return;
    const loadError = this.failedHere.get(manifest.id);
    if (loadError !== undefined) {
      p.status = 'error';
      p.error = loadError;
      return;
    }
    const { core } = entry;
    // No core side: nothing to activate here, so nothing it declares can be registered; its renderer side follows the switch.
    if (!core) {
      try {
        assertRegistered(entry.plugin, p.reg.registered);
      } catch (err) {
        p.status = 'error';
        p.error = errorMessage(err);
        return;
      }
      p.status = 'active';
      this.continuity.activated(manifest.id);
      return;
    }
    try {
      const { bundled } = this.deps;
      if (!bundled) throw new Error('This core provides no bundled-plugin host.');
      reservePluginId(bundled.ready(), manifest.id);
      const guard = (fn: () => unknown): void => this.guard(p, fn);
      const plugins: HostPlugins = { self: () => this.self, textPending: (id) => this.textPending(id), textSettled: (id) => this.textSettled(id), resumed };
      const ctx = createCoreContext(core.plugin, this.bundled.indexOf(entry), { ...this.deps, bundled }, p.reg, plugins, guard, this.ledger(manifest.id));
      const deactivate = core.activate(ctx);
      if (typeof deactivate === 'function') p.deactivate = deactivate;
      // A declaration it never registered fails the activation; unload then drops what it did register.
      assertRegistered(entry.plugin, p.reg.registered);
      createArchiveRefViews(bundled.ready(), entry.plugin);
      if (p.reg.handlers) this.ledger(manifest.id).adopt(p.reg.handlers);
      p.reg.handlers = null;
      p.status = 'active';
      this.continuity.activated(manifest.id);
    } catch (err) {
      p.status = 'error';
      p.error = errorMessage(err);
      unload(p);
    }
  }

  /** Bundled plugin `id`'s completion reports. */
  protected ledger(id: string): CompletionLedger {
    let ledger = this.ledgers.get(id);
    if (!ledger) {
      ledger = new CompletionLedger(this.bundled.find((b) => b.plugin.manifest.id === id)?.plugin.channels);
      this.ledgers.set(id, ledger);
    }
    return ledger;
  }
}
