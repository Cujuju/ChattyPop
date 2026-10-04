// AI providers as this window sees them (docs/plugin-architecture.md §3, AI providers): declared by the build, running
// while their plugin is on.
import { declaredProvider, declaredProviders, type DeclaredProvider } from '@shared/aiProviders';
import type { ProviderId } from '@shared/settings';
import { pluginActive } from './plugins';

/** Whether provider `id` can take requests: this build declares it and its plugin is on. Reactive. */
export const providerRuns = (id: ProviderId): boolean => {
  const declared = declaredProvider(id);
  return declared !== null && pluginActive(declared.plugin.id);
};

/** Providers that can take requests, in Settings → AI order. Reactive. */
export const availableProviders = (): DeclaredProvider[] => declaredProviders().filter((d) => providerRuns(d.id));

/** Display names of the local providers that can take requests (channels set to local AI only use them). Reactive. */
export const localProviderNames = (): string[] => availableProviders().filter((d) => d.local).map((d) => d.displayName);
