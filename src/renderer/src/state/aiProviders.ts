// AI providers as this window sees them (docs/plugin-architecture.md §3, AI providers): declared by the build, running
// while their plugin is on, and listed once the owner adds them.
import { declaredProvider, declaredProviders, providersOf, reportsPlanUsage, type DeclaredProvider } from '@shared/aiProviders';
import type { ProviderId } from '@shared/settings';
import { aiSettings, providerSettingsOf } from './preferences';
import { accountKey } from '@shared/providerAccounts';
import { pluginActive } from './plugins';

/** Whether provider `id` can take requests: this build declares it and its plugin is on. Reactive. */
export const providerRuns = (id: ProviderId): boolean => {
  const declared = declaredProvider(id);
  return (!accountKey(id) || aiSettings().accounts.some((a) => a.id === id)) && declared !== null && pluginActive(declared.plugin.id);
};

/** Whether provider `id` reports plan limits (an API-key account has none). Reactive. */
export const providerReportsPlanUsage = (id: ProviderId): boolean => reportsPlanUsage(id, aiSettings());

/** Whether the owner added provider `id`: a declared provider while it is on, an account while it is stored. Reactive. */
export const providerAdded = (id: ProviderId): boolean =>
  accountKey(id) ? aiSettings().accounts.some((a) => a.id === id) : providerSettingsOf(id).enabled;

/** Providers the owner added that can take requests, in Settings → AI order. Reactive. */
export const availableProviders = (): DeclaredProvider[] => providersOf(aiSettings()).filter((d) => providerRuns(d.id) && providerAdded(d.id));

/** Declared providers whose plugin is on, added or not: what Add account offers. Reactive. */
export const offeredProviders = (): DeclaredProvider[] => declaredProviders().filter((d) => pluginActive(d.plugin.id));

/** Display names of the local providers that can take requests (channels set to local AI only use them). Reactive. */
export const localProviderNames = (): string[] => availableProviders().filter((d) => d.local).map((d) => d.displayName);
