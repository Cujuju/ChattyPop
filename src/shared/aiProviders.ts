// Host-only provider registry supplies settings, choices and routing by id. Reads bundled registry; plugins must not import it.
import { BUNDLED_PLUGINS, bundledJevFeatures } from './bundledPlugins';
import type { PluginDescriptor } from './bundledTypes';
import type { ProviderDecl } from './descriptorParts';
import { normalizeAiSettings, type AiSettings, type ProviderId } from './aiSettings';
import { pluginAbsent, pluginNotRunning, type PluginStates } from './ruleAvailability';
import { accountKey, accountProvider, REMOVED_ACCOUNT, type AccountAuth } from './providerAccounts';

/** A declared provider and the plugin that declares it. */
export interface DeclaredProvider extends ProviderDecl {
  plugin: { id: string; name: string };
  account?: { auth: AccountAuth };
}

/** The providers `plugins` declare, in build order. */
export const providerDeclarations = (plugins: readonly PluginDescriptor[]): DeclaredProvider[] =>
  plugins.flatMap((p) => (p.providers ?? []).map((d) => ({ ...d, plugin: { id: p.manifest.id, name: p.manifest.name } })));

const DECLARED = providerDeclarations(BUNDLED_PLUGINS);
const LABEL_SEPARATOR = ' · ';
const ACCOUNT_UNSUPPORTED = 'This provider no longer supports this account kind.';
const ACCOUNT_KEY_COLLISION = 'This account shares a storage key with another account.';

/** Every provider this build declares, whether or not its plugin is on, in Settings → AI order. */
export const declaredProviders = (): readonly DeclaredProvider[] => DECLARED;
/** A declared provider by id; null when this build has none (its plugin is absent). */
export const declaredProvider = (id: ProviderId, declared: readonly DeclaredProvider[] = DECLARED): DeclaredProvider | null =>
  declared.find((d) => d.id === accountProvider(id)) ?? null;
/** The plugin a provider id belongs to: the id up to its first dot. */
export const providerPlugin = (id: ProviderId): string => accountProvider(id).split('.')[0]!;

/** Each declaration followed by its stored accounts, preserving both orders. */
export function providersOf(ai: AiSettings, declared: readonly DeclaredProvider[] = DECLARED): DeclaredProvider[] {
  return declared.flatMap((d) => [d, ...ai.accounts.filter((a) => accountProvider(a.id) === d.id).map((a) => {
    const name = providerDisplayName(ai, a.id, declared);
    const suffix = d.label.lastIndexOf(LABEL_SEPARATOR);
    const brand = suffix < 0 ? d.displayName : d.label.slice(0, suffix);
    return { ...d, id: a.id, label: `${brand}${LABEL_SEPARATOR}${name}`, displayName: name, account: { auth: a.auth } };
  })]);
}

/** Stored accounts survive plugin changes, but unsupported auth never falls back to the machine's sign-in. */
export function accountUnavailable(id: ProviderId, ai: AiSettings, declared: readonly DeclaredProvider[] = DECLARED): string | null {
  if (!accountKey(id)) return null;
  const account = ai.accounts.find((a) => a.id === id);
  if (!account) return REMOVED_ACCOUNT;
  if (ai.accounts.some((a) => a.id !== id && providerPlugin(a.id) === providerPlugin(id) && accountKey(a.id) === accountKey(id))) return ACCOUNT_KEY_COLLISION;
  const d = declaredProvider(id, declared);
  if (d && (!d.accounts || (account.auth === 'signIn' ? !d.accounts.signIn : !d.apiKey))) return ACCOUNT_UNSUPPORTED;
  return null;
}

/** Why a provider can't run: its plugin is absent, off or failed to start; null while it can. */
export function providerUnavailable(id: ProviderId, states: PluginStates, declared: readonly DeclaredProvider[] = DECLARED, ai?: AiSettings): string | null {
  const accountReason = accountUnavailable(id, ai ?? normalizeAiSettings(undefined), declared);
  if (accountReason) return accountReason;
  const d = declaredProvider(id, declared);
  if (!d) return pluginAbsent(providerPlugin(id));
  return pluginNotRunning(d.plugin.name, states(d.plugin.id));
}

/** Stored AI settings with this build's provider defaults. */
export const aiSettingsFrom = (stored: unknown): AiSettings => normalizeAiSettings(stored, DECLARED, bundledJevFeatures());


/** A provider's full name; its id when this build doesn't declare it. */
export const providerLabel = (id: ProviderId, ai?: AiSettings): string =>
  accountKey(id) ? providersOf(ai ?? normalizeAiSettings(undefined)).find((d) => d.id === id)?.label ?? id : declaredProvider(id)?.label ?? id;

/** A provider's short name: the owner's, else its declared one, else its id. */
export const providerDisplayName = (ai: AiSettings, id: ProviderId, declared: readonly DeclaredProvider[] = DECLARED): string =>
  ai.providers[id]?.displayName ?? (accountKey(id) && !ai.accounts.some((a) => a.id === id) ? id : declaredProvider(id, declared)?.displayName ?? id);
