// Host preferences.
import { api } from '@/api';
import { createEffect, createResource, createSignal } from 'solid-js';
import type { ProviderStatus } from '@shared/contract';
import { aiSettingsFrom, declaredProvider, providerDisplayName } from '@shared/aiProviders';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  builtInTheme,
  normalizeAppearanceSettings,
  type AppearanceSettings,
  DEFAULT_ARCHIVE_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  SETTINGS_KEYS,
  normalizeArchiveSettings,
  normalizeNotificationSettings,
  type AiSettings,
  type ArchiveSettings,
  type JevFeature,
  type NotificationSettings,
  type ProviderId,
  type ProviderSettings,
} from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { onAppEvent } from './events';
import { settingsOpen } from './ui';
import { failure, settled } from '@plugin-sdk/renderer/settled';
import { customBackgrounds, wearCustomTheme } from '@/theme/customTheme';
import { wearPanelColors } from '@/theme/panelColors';

const [storedAi, , { patch: patchAiSettings }] = createSetting<AiSettings>(SETTINGS_KEYS.ai, aiSettingsFrom(undefined), aiSettingsFrom);
/** Settings → AI: each provider's switch, model and effort, and the Jev switches. Reactive. */
export const aiSettings = (): AiSettings => storedAi();
/** Merges fields into the stored AI settings; a default kept for a provider that can't run now stays stored. */
export { patchAiSettings };
/** Makes provider `id` the default. */
/** A provider's short name: the owner's, else its declared one. Reactive. */
export const providerName = (id: ProviderId): string => providerDisplayName(storedAi(), id);
/** Provider `id`'s stored settings, else a profile's that never set them. Reactive. */
export const providerSettingsOf = (id: ProviderId): ProviderSettings =>
  storedAi().providers[id] ?? { enabled: declaredProvider(id)?.enabledByDefault ?? false, model: null, effort: null, displayName: null };
/** Changes provider `id`'s stored settings, keeping the rest. */
export const updateProvider = (id: ProviderId, patch: Partial<ProviderSettings>): void =>
  void patchAiSettings({ providers: { ...storedAi().providers, [id]: { ...providerSettingsOf(id), ...patch } } });
/** The owner's short name for provider `id`; null uses its declared one. */
export const setProviderDisplayName = (id: ProviderId, name: string | null): void => updateProvider(id, { displayName: name });
export const [archiveSettings, setArchiveSettings, { patch: patchArchiveSettings }] = createSetting<ArchiveSettings>(
  SETTINGS_KEYS.archive,
  DEFAULT_ARCHIVE_SETTINGS,
  normalizeArchiveSettings,
);
export const [notificationSettings, setNotificationSettings, { patch: patchNotificationSettings }] = createSetting<NotificationSettings>(
  SETTINGS_KEYS.notifications,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
);

/** Turns one Settings → Jev feature on or off, keeping the rest of the AI settings as stored. */
export const setJevFeature = (feature: JevFeature, on: boolean): void => void patchAiSettings({ jev: { ...aiSettings().jev, [feature]: on } });

/** Last applied appearance (JSON): the setting starts from it, so a window's first paint does not flash the default while the stored value loads (async IPC). */
const THEME_CACHE_KEY = 'chattypop.theme';

function cachedAppearance(): AppearanceSettings {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached === null) return DEFAULT_APPEARANCE_SETTINGS;
    // Before custom themes the cache held the bare theme id.
    return normalizeAppearanceSettings(cached.startsWith('{') ? JSON.parse(cached) : { theme: cached });
  } catch {
    return DEFAULT_APPEARANCE_SETTINGS;
  }
}

export const [appearanceSettings, setAppearanceSettings, { patch: patchAppearanceSettings }] = createSetting<AppearanceSettings>(
  SETTINGS_KEYS.appearance,
  cachedAppearance(),
  normalizeAppearanceSettings,
);

/** Copies the owner's Discord custom theme into the custom theme and wears it; settles once stored, else rejects with Discord's, the reader's or the store's reason. */
export async function importDiscordTheme(): Promise<void> {
  const custom = await api.discord.customTheme();
  await patchAppearanceSettings({ theme: 'custom', custom });
}

const [themeApplied, setThemeApplied] = createSignal(0);
/** Counts themes applyTheme has finished wearing; read it to re-read theme tokens from the DOM once they're in place. Reactive. */
export { themeApplied };

/** Sets `data-theme` on <html> (theme CSS keys on it), a custom theme's tokens inline and the panel colours, in step with the setting. Call once inside the render root. */
export function applyTheme(): void {
  createEffect(() => {
    const a = appearanceSettings();
    const html = document.documentElement;
    html.dataset['theme'] = builtInTheme(a);
    const custom = a.theme === 'custom' ? a.custom : null;
    wearCustomTheme(html, custom, (token) => getComputedStyle(html).getPropertyValue(token).trim());
    wearPanelColors(html, a.panelColors, custom ? customBackgrounds(custom) : []);
    setThemeApplied((n) => n + 1);
    try {
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(a));
    } catch {
      // Cache only; the setting itself is stored by createSetting.
    }
  });
}

/**
 * Availability and model lists per provider. Loaded only while Settings is open (listing Claude/Codex
 * models spawns their CLIs). `refreshProviderStatus` re-lists models past the session cache.
 */
const [providerStatusRead, { refetch: refetchProviderStatus }] = createResource<ProviderStatus[], true, boolean>(
  () => settingsOpen() || undefined,
  (_open, info) => api.core.aiStatus(info.refetching === true),
  { initialValue: [] },
);
export { refetchProviderStatus };
/** The providers' states; none while unread or after a failed read (providerStatusFailure says why). Never throws. Reactive. */
export const providerStatus = (): ProviderStatus[] => settled(providerStatusRead) ?? [];
/** Why the last provider-status read failed; null while it didn't. Reactive. */
export const providerStatusFailure = (): string | null => failure(providerStatusRead);
/** Whether a provider-status read is in flight. Reactive. */
export const providerStatusLoading = (): boolean => providerStatusRead.loading;
export const refreshProviderStatus = (): unknown => refetchProviderStatus(true);
// A provider plugin turned on or off: the providers listed change.
onAppEvent('plugins-changed', () => void refetchProviderStatus());
