// Plugin activation, dispatch, failure reporting and disposal.
import { createArchiveRefViews } from './archiveRefs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginInactiveError } from '@shared/pluginCall';
import { errorMessage } from '@shared/errors';
import { switchState, type PluginState } from '@shared/ruleAvailability';
import {
  PLUGIN_API_MAJOR_CHANGES,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILE,
  type PluginApi,
  type PluginInfo,
  type PluginManifest,
  type PluginMessage,
  type PluginOrigin,
  type PluginRange,
  type PluginStatus,
} from '@shared/plugins';
import type { InstalledFailure } from '@shared/installedCheck';
import type { InstalledStart } from '@shared/installedPlugins';
import type { Arrived, TextMessage } from '../arrival';
import { getSetting, setSetting } from '../db';
import { createPluginApi, emptyRegistrations, type HostDeps, type Registrations } from './api';
import { unregisterMessageQuestion } from '../jev/messageQuestions';
import { unregisterAttachmentNotes } from '../attachmentNotes';
import { audiencesOf, completionOf, type Audience } from '@shared/pluginChannels';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { HostPlugins, TextSource } from './bundled';
import { CompletionLedger } from './completions';
import { createCoreContext, type CorePlugin } from './context';
import { assertRegistered } from './registrationCheck';
import { ActivationContinuity } from './continuity';

/** Ids of plugins the user turned off (Settings → Plugins). */
export const PLUGINS_DISABLED_KEY = 'plugins.disabled';

interface PluginModule {
  activate(api: PluginApi): void | (() => void) | Promise<void | (() => void)>;
}

interface Loaded {
  manifest: PluginManifest;
  /** The plugin folder; '' for a bundled plugin. */
  dir: string;
  origin: PluginOrigin;
  /** Set for a descriptor plugin (bundled or installed) that loaded; null for a folder plugin or a refused installed one. */
  entry: BundledEntry | null;
  status: PluginStatus;
  error: string | null;
  reg: Registrations;
  deactivate?: () => void;
}

/** Bundled descriptor and optional core side. */
interface BundledEntry {
  plugin: PluginDescriptor;
  core: CorePlugin | null;
}

/** Installed plugins as this process has them (§16): main's start, and accepted ones whose node modules failed here. */
export interface InstalledPlugins {
  start: InstalledStart;
  failed: readonly InstalledFailure[];
}
const NO_INSTALLED: InstalledPlugins = { start: { accepted: [], refused: [] }, failed: [] };

/** Why a folder plugin can't take an id, by where the plugin holding it comes from. */
const TAKEN_BY: Readonly<Record<PluginOrigin, (id: string) => string>> = {
  bundled: (id) => `ChattyPop already includes plugin ${id}`,
  installed: (id) => `An installed plugin already provides plugin ${id}`,
  folder: (id) => `Another folder already provides plugin ${id}`,
};

const major = (semver: string): number => Number(semver.split('.')[0]);
const minor = (semver: string): number => Number(semver.split('.')[1] ?? 0);
/** A manifest path must stay inside its plugin folder. */
const insideFolder = (dir: string, rel: string): boolean => resolve(dir, rel).startsWith(resolve(dir) + sep);

function readManifest(dir: string): PluginManifest {
  const m = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')) as Partial<PluginManifest>;
  if (typeof m.id !== 'string' || !PLUGIN_ID_PATTERN.test(m.id)) throw new Error(`plugin.json: id must match ${PLUGIN_ID_PATTERN}`);
  if (typeof m.version !== 'string' || typeof m.apiVersion !== 'string' || typeof m.main !== 'string') {
    throw new Error('plugin.json: version, apiVersion and main are required');
  }
  // Same major, and no newer minor than the host: a minor adds API the plugin may call. An older major says what changed.
  const hostMajor = major(PLUGIN_API_VERSION);
  if (major(m.apiVersion) < hostMajor) {
    throw new Error(
      `written for plugin API ${m.apiVersion}; this ChattyPop provides ${PLUGIN_API_VERSION}, where ${PLUGIN_API_MAJOR_CHANGES}. Update it for API ${hostMajor} (docs/plugins.md).`,
    );
  }
  if (major(m.apiVersion) !== hostMajor || minor(m.apiVersion) > minor(PLUGIN_API_VERSION)) {
    throw new Error(`written for plugin API ${m.apiVersion}; this ChattyPop provides ${PLUGIN_API_VERSION}`);
  }
  return m as PluginManifest;
}

/**
 * Loads the bundled plugins this build includes, then plugins from <plugins dir>/<folder>/plugin.json; dispatches hooks
 * to them and isolates their failures. Both kinds share on/off (Settings → Plugins) and error reporting.
 */
export class PluginHost {
  private readonly plugins = new Map<string, Loaded>();
  /** Bumped on every reload so the ESM loader re-reads changed entry files. */
  private generation = 0;
  /** The signed-in Discord user, once main reports it; handed to bundled plugins that load later. */
  private self: string | null = null;
  private bundledStarted = false;
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
    private readonly deps: HostDeps,
    core: readonly CorePlugin[] = [],
    /** This build's descriptors, then accepted installed ones (BUNDLED_PLUGINS); defaults to the core entries' own. */
    descriptors: readonly PluginDescriptor[] = core.map((c) => c.plugin),
    private readonly installed: InstalledPlugins = NO_INSTALLED,
  ) {
    this.installedDirs = new Map(installed.start.accepted.map((p) => [p.manifest.id, p.dir]));
    this.failedHere = new Map(installed.failed.map((f) => [f.id, f.error]));
    const byId = new Map(core.map((c) => [c.plugin.manifest.id, c]));
    this.bundled = descriptors.map((plugin) => ({ plugin, core: byId.get(plugin.manifest.id) ?? null }));
    const unlisted = core.filter((c) => !descriptors.some((d) => d.manifest.id === c.plugin.manifest.id));
    if (unlisted.length) throw new Error(`Core entries without a bundled descriptor: ${unlisted.map((c) => c.plugin.manifest.id).join(', ')}`);
    this.continuity = new ActivationContinuity(() => deps.db);
    deps.bundled?.providers.bindPlugins((id) => this.state(id));
    deps.bundled?.rules.bindPlugins((id) => this.state(id));
  }

  /** Plugin `id` as unavailability reasons read it; off while not loaded. */
  state(id: string): PluginState {
    const p = this.plugins.get(id);
    return p?.status === 'error' ? { status: 'error', error: p.error } : switchState(p?.status === 'active');
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
      this.unload(p);
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
      this.unload(p);
    }
    this.deps.bundled?.rules.changed();
    // What arrived while it was off: its questions are registered and its rules compiled again.
    if (activated && this.plugins.get(id)?.status === 'active') this.deps.bundled?.catchUp();
    this.deps.emit({ type: 'rules-changed' });
    this.deps.emit({ type: 'plugins-changed' });
  }

  /** Ends activations before archive closure without changing switches or continuity. The app restarts afterward. */
  endActivations(): void {
    for (const p of this.plugins.values()) if (p.status === 'active') this.unload(p);
  }

  private disabled(): Set<string> {
    return new Set((getSetting(this.deps.db, PLUGINS_DISABLED_KEY) as string[] | undefined) ?? []);
  }

  private async loadFolders(disabled: Set<string>): Promise<void> {
    this.generation++;
    if (!existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await this.load(join(this.dir, entry.name), disabled);
    }
  }

  list(): PluginInfo[] {
    return [...this.plugins.entries()].map(([key, p]) => ({
      key,
      conflict: key !== p.manifest.id,
      id: p.manifest.id,
      name: p.manifest.name ?? p.manifest.id,
      version: p.manifest.version,
      description: p.manifest.description ?? null,
      dir: p.dir,
      bundled: p.origin !== 'folder',
      origin: p.origin,
      status: p.status,
      error: p.error,
      commands: [...p.reg.commands.values()].map((c) => ({ id: c.id, title: c.title })),
      renderer: p.status === 'active' && p.manifest.renderer && insideFolder(p.dir, p.manifest.renderer) ? p.manifest.renderer : null,
    }));
  }

  /** Ingest defers onMessage handlers. Bundled onText handlers only record work synchronously; plugin errors are recorded without interrupting archiving. */
  dispatchMessage(m: TextMessage, arrived: Arrived, source: TextSource): void {
    const message: PluginMessage = { id: m.id, channelId: m.channelId, authorId: m.authorId, ts: m.ts, content: m.content };
    for (const p of this.active()) {
      // Deferred: a plugin turned off before it runs never hears the message.
      const { reg } = p;
      for (const handler of reg.onMessage) setImmediate(() => void (!reg.unloaded && this.guard(p, () => handler(message))));
      for (const handler of p.reg.onText) this.guard(p, () => handler(m, arrived, source));
    }
  }

  /** Main reported the signed-in user. */
  setSelf(userId: string): void {
    this.self = userId;
    for (const p of this.active()) for (const fn of p.reg.onSelf) this.guard(p, () => fn(userId));
  }

  /** Some plugin's derived text for `messageId` settled (derivedText.settle). */
  textSettled(messageId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onTextSettled) this.guard(p, () => fn(messageId));
  }

  /** Any active plugin's derived text for `messageId` is still coming. A throw counts as not pending. */
  textPending(messageId: string): boolean {
    return this.active().some((p) => p.reg.textPending.some((fn) => this.ask(p, () => fn(messageId), false)));
  }

  /** An attachment reached the store. */
  attachmentStored(attachmentId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onAttachmentStored) this.guard(p, () => fn(attachmentId));
  }

  /** A message was stored or updated, or its links gained images: the images it shows may be new (archive.images). */
  imagesShown(messageId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onShown) this.guard(p, () => fn(messageId));
  }

  /** Messages in these channels changed (debounced; real channels only). */
  archiveChanged(channelIds: string[]): void {
    for (const p of this.active()) for (const fn of p.reg.onArchiveChanged) this.guard(p, () => fn(channelIds));
  }

  /** The link index was rebuilt from stored messages; runs inside the rebuild's transaction. */
  linksRebuilt(): void {
    for (const p of this.active()) for (const fn of p.reg.onLinksRebuilt) this.guard(p, fn);
  }

  /** Setting `key` was saved. */
  settingChanged(key: string): void {
    for (const p of this.active()) for (const h of p.reg.onSettingChanged) if (h.key === key) this.guard(p, h.fn);
  }

  private active(): Loaded[] {
    return [...this.plugins.values()].filter((p) => p.status === 'active');
  }

  /** Dispatches transport-stamped core calls to declared bundled audiences or folder panels. Records folder errors; bundled errors remain caller-visible only. */
  async call(origin: Audience, pluginId: string, name: string, args: unknown[]): Promise<unknown> {
    const p = this.plugins.get(pluginId);
    const reaches = p?.entry ? audiencesOf(p.entry.plugin.channels, 'core', name).includes(origin) : p?.origin === 'folder' && origin === 'renderer';
    // Main's report of work the plugin started: its latest handler takes it, on or off.
    const ledger = reaches && p?.entry && completionOf(p.entry.plugin.channels, name) ? this.ledger(pluginId) : null;
    if (ledger?.handles(name)) return ledger.report(name, args);
    const fn = reaches && p?.status === 'active' ? p.reg.calls.get(name) : undefined;
    if (p && reaches && p.status !== 'active') throw new PluginInactiveError(pluginId);
    if (!p || !fn) throw new Error(`Plugin ${pluginId} has no function ${name} for ${origin}`);
    try {
      return await fn(...args);
    } catch (err) {
      if (p.origin === 'folder') this.fail(p, err);
      throw err;
    }
  }

  async runCommand(pluginId: string, commandId: string, range: PluginRange): Promise<string | null> {
    const p = this.plugins.get(pluginId);
    const command = p?.status === 'active' ? p.reg.commands.get(commandId) : undefined;
    if (!p || !command) throw new Error(`No command ${commandId} in plugin ${pluginId}`);
    try {
      return (await command.run(range)) ?? null;
    } catch (err) {
      this.fail(p, err);
      throw err;
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
    if (disabled.has(manifest.id)) return;
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
      this.unload(p);
    }
  }

  private async load(dir: string, disabled: Set<string>): Promise<void> {
    let manifest: PluginManifest;
    try {
      manifest = readManifest(dir);
    } catch (err) {
      const id = dir.split(sep).pop()!;
      this.plugins.set(this.plugins.has(id) ? `${id}@${dir}` : id, { manifest: { id, version: '?', apiVersion: '?', main: '' }, dir, origin: 'folder', entry: null, status: 'error', error: errorMessage(err), reg: emptyRegistrations() });
      return;
    }
    const p: Loaded = { manifest, dir, origin: 'folder', entry: null, status: 'disabled', error: null, reg: emptyRegistrations() };
    const taken = this.plugins.get(manifest.id);
    if (taken) {
      p.status = 'error';
      p.error = TAKEN_BY[taken.origin](manifest.id);
      this.plugins.set(`${manifest.id}@${dir}`, p);
      return;
    }
    this.plugins.set(manifest.id, p);
    if (disabled.has(manifest.id)) return;
    const entry = resolve(dir, manifest.main);
    if (!insideFolder(dir, manifest.main)) {
      p.status = 'error';
      p.error = 'main must be inside the plugin folder';
      return;
    }
    try {
      const mod = (await import(`${pathToFileURL(entry).href}?v=${this.generation}`)) as PluginModule;
      if (typeof mod.activate !== 'function') throw new Error(`${manifest.main} does not export activate(api)`);
      const api = createPluginApi(manifest.id, this.deps, p.reg, (fn) => this.guard(p, fn));
      const deactivate = await mod.activate(api);
      if (typeof deactivate === 'function') p.deactivate = deactivate;
      p.status = 'active';
    } catch (err) {
      this.unload(p);
      p.status = 'error';
      p.error = errorMessage(err);
    }
  }

  private unload(p: Loaded): void {
    p.reg.unloaded = true;
    p.reg.timers.forEach(clearInterval);
    p.reg.disposers.forEach((dispose) => dispose());
    p.reg.jevQuestions.forEach(unregisterMessageQuestion);
    if (p.reg.attachmentNotes) unregisterAttachmentNotes(p.manifest.id);
    try {
      p.deactivate?.();
    } catch (err) {
      console.error(`[plugin ${p.manifest.id}] deactivate failed`, err);
    }
    p.reg = emptyRegistrations();
    p.deactivate = undefined;
  }

  /** Bundled plugin `id`'s completion reports. */
  private ledger(id: string): CompletionLedger {
    let ledger = this.ledgers.get(id);
    if (!ledger) {
      ledger = new CompletionLedger(this.bundled.find((b) => b.plugin.manifest.id === id)?.plugin.channels);
      this.ledgers.set(id, ledger);
    }
    return ledger;
  }

  /** Runs a plugin's synchronous query; a throw is recorded on the plugin and answers `fallback`. */
  private ask<T>(p: Loaded, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.fail(p, err);
      return fallback;
    }
  }

  /** Runs plugin code; a throw or rejection is recorded on the plugin and shown in Settings. */
  private guard(p: Loaded, fn: () => unknown): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((err: unknown) => this.fail(p, err));
    } catch (err) {
      this.fail(p, err);
    }
  }

  private fail(p: Loaded, err: unknown): void {
    console.error(`[plugin ${p.manifest.id}]`, err);
    const changed = p.error !== errorMessage(err);
    p.error = errorMessage(err);
    if (changed) this.deps.emit({ type: 'plugins-changed' });
  }
}
