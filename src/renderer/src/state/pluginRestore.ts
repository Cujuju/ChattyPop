// First-start restore (docs/plugin-architecture.md §16): plugins whose data the profile holds but that aren't installed,
// matched against fresh marketplace listings; installs go through the marketplace, then its restart notice.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { HostSettingsTabId } from '@shared/anchors';
import { PLUGIN_RESTORE_KEY, normalizePluginRestore, restoreItems, type AbsentPlugin, type RestoreItem } from '@shared/pluginRestore';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { errorText } from '@/ui/format';
import { actionBusy, actionKey, installPlugin, loadMarketplaces, marketplaceState, refreshMarketplaces } from './marketplace';
import { onAppEvent } from './events';
import { openSettingsAt } from './ui';

/** The Settings tab whose notice slot offers the plugins. */
const PLUGINS_TAB: HostSettingsTabId = 'plugins';

const [settings, setSettings, { loaded: settingsLoaded }] = createSetting(PLUGIN_RESTORE_KEY, normalizePluginRestore(undefined), normalizePluginRestore);
const [absent, setAbsent] = createSignal<AbsentPlugin[] | null>(null);
const [loadError, setLoadError] = createSignal<string | null>(null);
/** Why core couldn't report absent plugins; null when it did. Reactive. */
export const restoreLoadError = loadError;
/** While listings are fetched for matching. Reactive. */
export const restoreChecking = (): boolean => actionBusy(actionKey.refresh);

let loadGeneration = 0;
/** Reads absent plugins from core, then fetches listings not read since this start; a later load wins. */
export async function loadRestore(): Promise<void> {
  const mine = ++loadGeneration;
  try {
    const found = await api.core.absentPlugins();
    if (mine !== loadGeneration) return;
    setAbsent(found);
    setLoadError(null);
    if (!found.length) return;
    if (!marketplaceState()) await loadMarketplaces();
    // Listings are fetched only on refresh after a start (§16); matching needs them.
    if (marketplaceState()?.marketplaces.some((m) => m.fetchedAt === null)) await refreshMarketplaces();
  } catch (err) {
    if (mine === loadGeneration) setLoadError(errorText(err));
  }
}
// Plugins load, reload or turn up elsewhere; only once read, so windows that never offer restore never call it.
onAppEvent('plugins-changed', () => void (absent() && loadRestore()));

/** Absent plugins to offer, not dismissed, uninstalled or installed meanwhile. Reactive. */
export function restoreOffers(): RestoreItem[] {
  const found = absent();
  const state = marketplaceState();
  if (!found?.length || !state) return [];
  return restoreItems(found, state.marketplaces, state.installed, state.history, settings().dismissed);
}

/** Stages `item` from its marketplace; its restart notice follows. Resolves whether it succeeded. */
export const installRestore = (item: RestoreItem): Promise<boolean> =>
  item.install ? installPlugin(item.install.repo, item.id, item.install.choice) : Promise.resolve(false);

/** Stages every installable offer; each one's error shows on its row. */
export const installAllRestore = async (): Promise<void> => void (await Promise.all(restoreOffers().map(installRestore)));

/** Never offers plugin `id` again. */
export function dismissRestore(id: string): void {
  const s = settings();
  if (!s.dismissed.includes(id)) setSettings({ ...s, dismissed: [...s.dismissed, id] });
}

/** At app start, in the main window: opens Settings → Plugins when it offers plugins the start hasn't shown before. */
export async function promptRestoreAtStart(): Promise<void> {
  await settingsLoaded;
  await loadRestore();
  const s = settings();
  const fresh = restoreOffers().filter((item) => !s.prompted.includes(item.id));
  if (!fresh.length) return;
  setSettings({ ...s, prompted: [...s.prompted, ...fresh.map((item) => item.id)] });
  openSettingsAt(PLUGINS_TAB);
}
