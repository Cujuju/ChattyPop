// Settings → Plugins → Marketplaces (docs/plugin-architecture.md §16): main's marketplace state, its actions, and what
// each listed plugin offers. Every change applies at the next start; the state reloads after each action.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import { VERSION_PATTERN, compareVersions, sdkMismatch, type InstalledSource } from '@shared/installedPlugins';
import type { InstallChoice, InstalledEntry, MarketplacePlugin, MarketplaceRelease, MarketplaceState } from '@shared/marketplace';
import { newestCompatible } from '@shared/pluginRestore';
import { errorText } from '@/ui/format';
import { onAppEvent } from './events';

const [state, setState] = createSignal<MarketplaceState | null>(null);
const [loadError, setLoadError] = createSignal<string | null>(null);
/** Marketplaces and installed plugins as main last reported them; null until the first load. Reactive. */
export const marketplaceState = state;
/** Why the last load failed; null when it succeeded. Reactive. */
export const marketplaceLoadError = loadError;

let loadGeneration = 0;
/** Reads main's state; a load started later wins, so a stale answer never lands. */
export async function loadMarketplaces(): Promise<void> {
  const mine = ++loadGeneration;
  try {
    const next = await api.marketplace.state();
    if (mine !== loadGeneration) return;
    setState(next);
    setLoadError(null);
  } catch (err) {
    if (mine === loadGeneration) setLoadError(errorText(err));
  }
}
// Plugin changes elsewhere; only once shown, so windows that never open this view never call it.
onAppEvent('plugins-changed', () => void (state() && loadMarketplaces()));

/** Busy and error slots, one per action target (`actionKey`). */
const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set());
const [errors, setErrors] = createSignal<Readonly<Record<string, string>>>({});
export const actionBusy = (key: string): boolean => busyKeys().has(key);
export const actionError = (key: string): string | null => errors()[key] ?? null;
/** Whether any action is in flight (restart waits for none). */
export const anyBusy = (): boolean => busyKeys().size > 0;

/** Each action's slot: one per marketplace, per plugin, or the whole view. */
export const actionKey = {
  add: 'add',
  refresh: 'refresh',
  local: 'local',
  restart: 'restart',
  marketplace: (repo: string) => `marketplace:${repo}`,
  plugin: (id: string) => `plugin:${id}`,
} as const;

function setError(key: string, error: string | null): void {
  setErrors((all) => {
    const { [key]: _dropped, ...rest } = all;
    return error === null ? rest : { ...rest, [key]: error };
  });
}

/** Runs `job` in slot `key`, then reloads the state whatever happened. Resolves whether it succeeded. */
async function perform(key: string, job: () => Promise<void>): Promise<boolean> {
  setBusyKeys((s) => new Set(s).add(key));
  setError(key, null);
  try {
    await job();
    return true;
  } catch (err) {
    setError(key, errorText(err));
    return false;
  } finally {
    await loadMarketplaces();
    setBusyKeys((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }
}

export const addMarketplace = (repo: string, token: string | null): Promise<boolean> => perform(actionKey.add, () => api.marketplace.add(repo, token));
export const removeMarketplace = (repo: string): Promise<boolean> => perform(actionKey.marketplace(repo), () => api.marketplace.remove(repo));
export const setMarketplaceToken = (repo: string, token: string | null): Promise<boolean> =>
  perform(actionKey.marketplace(repo), () => api.marketplace.setToken(repo, token));
export const refreshMarketplaces = (): Promise<boolean> => perform(actionKey.refresh, () => api.marketplace.refresh());
export const installPlugin = (repo: string, pluginId: string, choice: InstallChoice): Promise<boolean> =>
  perform(actionKey.plugin(pluginId), () => api.marketplace.install(repo, pluginId, choice));
export const installLocalPlugin = (path: string): Promise<boolean> => perform(actionKey.local, () => api.marketplace.installLocal(path));
export const uninstallPlugin = (pluginId: string): Promise<boolean> => perform(actionKey.plugin(pluginId), () => api.marketplace.uninstall(pluginId));
export const cancelPending = (pluginId: string): Promise<boolean> => perform(actionKey.plugin(pluginId), () => api.marketplace.cancel(pluginId));
export const restartApp = (): Promise<boolean> => perform(actionKey.restart, () => api.restartApp());

/** Installed plugins the next start changes. Reactive. */
export const pendingChanges = (): InstalledEntry[] => state()?.installed.filter((e) => e.pending) ?? [];
/** Installed plugin `id`, if any. Reactive. */
export const installedEntry = (id: string): InstalledEntry | undefined => state()?.installed.find((e) => e.id === id);
/** Installed plugins no added marketplace lists (local installs, or a marketplace since removed). Reactive. */
export const unlistedInstalled = (): InstalledEntry[] => {
  const s = state();
  if (!s) return [];
  const listed = new Set(s.marketplaces.flatMap((m) => m.plugins.map((p) => p.id)));
  return s.installed.filter((e) => !listed.has(e.id));
};

/** Characters of a commit hash shown: git's default short hash. */
const SHORT_COMMIT_LENGTH = 7;
/** Where an install came from, in a few words. */
export function sourceText(source: InstalledSource | null): string {
  if (!source) return 'unknown source';
  if (source.kind === 'release') return `release ${source.tag}`;
  if (source.kind === 'source') return `source ${source.commit.slice(0, SHORT_COMMIT_LENGTH)} (${source.branch})`;
  return 'local build';
}

const versionText = (version: string, source: InstalledSource | null): string => `${version} (${sourceText(source)})`;

/** Its versions: what runs now (with its repo when that isn't `listedIn`), then what the next start installs; null when neither. */
export function versionsText(entry: InstalledEntry | undefined, listedIn?: string): string | null {
  if (!entry) return null;
  const repo = entry.source && entry.source.kind !== 'local' && entry.source.repo !== listedIn ? ` from ${entry.source.repo}` : '';
  const now = entry.version ? `${versionText(entry.version, entry.source)}${repo}` : null;
  const next = entry.pending?.kind === 'install' ? versionText(entry.pending.version, entry.pending.source) : null;
  if (now && next) return `Running ${now} → ${next}`;
  return now ? `Running ${now}` : next && `Next start: ${next}`;
}

/** A status pill: its text, and its look.status tint (null: the accent). */
export interface ChangeStatus {
  label: string;
  tint: 'danger' | 'neutral' | null;
}

/** What the next start does to it, or that it runs unchanged; null when it's neither installed nor staged. */
export function changeStatus(entry: InstalledEntry | undefined): ChangeStatus | null {
  if (entry?.pending?.kind === 'remove') return { label: 'Pending uninstall', tint: 'danger' };
  if (entry?.pending) return { label: entry.version ? 'Pending update' : 'Pending install', tint: null };
  return entry?.version ? { label: 'Installed', tint: 'neutral' } : null;
}

/** Its pending change in a few words ("Tags 1.0.0 installs"); null when nothing is pending. */
export function pendingText(entry: InstalledEntry | undefined): string | null {
  const pending = entry?.pending;
  if (!entry || !pending) return null;
  if (pending.kind === 'remove') return `${entry.name} is uninstalled`;
  return entry.version ? `${entry.name} updates to ${pending.version}` : `${entry.name} ${pending.version} installs`;
}

/** The Cancel button's text for its pending change; null when nothing is pending. */
export function cancelText(entry: InstalledEntry): string | null {
  if (!entry.pending) return null;
  if (entry.pending.kind === 'remove') return 'Cancel uninstall';
  return entry.version ? 'Cancel update' : 'Cancel install';
}

/** Whether Uninstall applies: it runs now and its removal isn't staged yet. */
export const removable = (entry: InstalledEntry): boolean => entry.version !== null && entry.pending?.kind !== 'remove';

/** What a listed plugin's release install offers: the release it installs, the button, and why none can. */
export interface ReleaseOffer {
  /** The newest release this ChattyPop can run; null when none. */
  release: MarketplaceRelease | null;
  /** The install button's text; null when there's nothing to install (up to date, or none compatible). */
  action: string | null;
  /** Why the newest release (or every release) can't run here; null when it can. */
  incompatible: string | null;
}

/** The release install `plugin` (listed in `repo`) offers, given what's installed (or staged) now. */
export function releaseOffer(repo: string, plugin: MarketplacePlugin, entry: InstalledEntry | undefined): ReleaseOffer {
  const newest = plugin.releases[0];
  if (!newest) return { release: null, action: null, incompatible: null };
  const release = newestCompatible(plugin);
  const incompatible = sdkMismatch(newest.sdk);
  if (!release) return { release: null, action: null, incompatible };
  // A staged install replaces the running version. A staged removal is judged against the running one: Cancel uninstall
  // restores it, and an install of another release clears the removal.
  const next = entry?.pending?.kind === 'install' ? entry.pending : entry;
  if (!next?.version) return { release, action: `Install ${release.version}`, incompatible };
  // A version that isn't x.y.z (a local 1.0.0-beta) has no order against a release: offered as a switch, never an update.
  const order = VERSION_PATTERN.test(next.version) ? compareVersions(release.version, next.version) : null;
  if (order === 0 && next.source?.kind === 'release' && next.source.repo === repo) return { release, action: null, incompatible };
  // Not newer than what the next start runs, unordered, or from another source: a switch to this release.
  return { release, action: order !== null && order > 0 ? `Update to ${release.version}` : `Switch to release ${release.version}`, incompatible };
}
