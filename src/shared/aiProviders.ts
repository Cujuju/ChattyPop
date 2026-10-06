// Host-only provider registry supplies settings, choices and routing by id. Reads bundled registry; plugins must not import it.
import { BUNDLED_PLUGINS, bundledJevFeatures } from './bundledPlugins';
import type { PluginDescriptor } from './bundledTypes';
import type { ProviderDecl } from './descriptorParts';
import { normalizeAiSettings, type AiSettings, type ProviderId } from './aiSettings';
import { pluginAbsent, pluginNotRunning, type PluginStates } from './ruleAvailability';

/** A declared provider and the plugin that declares it. */
export interface DeclaredProvider extends ProviderDecl {
  plugin: { id: string; name: string };
}

/** The providers `plugins` declare, in build order. */
export const providerDeclarations = (plugins: readonly PluginDescriptor[]): DeclaredProvider[] =>
  plugins.flatMap((p) => (p.providers ?? []).map((d) => ({ ...d, plugin: { id: p.manifest.id, name: p.manifest.name } })));

const DECLARED = providerDeclarations(BUNDLED_PLUGINS);

/** Every provider this build declares, whether or not its plugin is on, in Settings → AI order. */
export const declaredProviders = (): readonly DeclaredProvider[] => DECLARED;
/** A declared provider by id; null when this build has none (its plugin is absent). */
export const declaredProvider = (id: ProviderId, declared: readonly DeclaredProvider[] = DECLARED): DeclaredProvider | null =>
  declared.find((d) => d.id === id) ?? null;
/** The plugin a provider id belongs to: the id up to its first dot. */
export const providerPlugin = (id: ProviderId): string => id.split('.')[0]!;

/** Why a provider can't run: its plugin is absent, off or failed to start; null while it can. */
export function providerUnavailable(id: ProviderId, states: PluginStates, declared: readonly DeclaredProvider[] = DECLARED): string | null {
  const d = declaredProvider(id, declared);
  if (!d) return pluginAbsent(providerPlugin(id));
  return pluginNotRunning(d.plugin.name, states(d.plugin.id));
}

/** Stored AI settings with this build's provider defaults. */
export const aiSettingsFrom = (stored: unknown): AiSettings => normalizeAiSettings(stored, DECLARED, bundledJevFeatures());


/** A provider's full name; its id when this build doesn't declare it. */
export const providerLabel = (id: ProviderId): string => declaredProvider(id)?.label ?? id;

/** A provider's short name: the owner's, else its declared one, else its id. */
export const providerDisplayName = (ai: AiSettings, id: ProviderId): string =>
  ai.providers[id]?.displayName ?? declaredProvider(id)?.displayName ?? id;
