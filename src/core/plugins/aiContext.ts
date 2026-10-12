// A bundled plugin's AI services (docs/plugin-architecture.md §3, AI providers and AI usage): settings, providers it
// registers or requests, completions and usage. Registrations are dropped when the plugin turns off.
import { join } from 'node:path';
import { accountProvider } from '@shared/providerAccounts';
import type { PluginDescriptor, ProviderIds } from '@shared/bundledTypes';
import { SETTINGS_KEYS, type AiSettings, type ProviderId } from '@shared/settings';
import { apiCost, type PriceAtApiRates } from '../ai/apiRates';
import type { OpenRouterKeyReader } from '../ai/registry';
import { aiSources, assertProviderMayRead, scopedProvider, type AiSources, type PluginProvider } from '../ai/readScope';
import { ProviderUnavailableError, offReason, type ProviderImpl, type ProviderInfo } from '../ai/types';
import { registerUsage, type UsageReader } from '../ai/usage';
import { servicesLive, type Registrations } from './api';
import { revocable } from '../ai/revocable';
import { keyError } from '../ai/keyError';
import type { BundledDeps } from './bundled';
import { registration } from './registrationCheck';

/** AI services scoped to one bundled plugin. */
export interface PluginAi<D extends PluginDescriptor = PluginDescriptor> {
  /** Settings → AI: each provider's switch, model and effort, and the Jev switches. A feature picks its own provider. */
  settings(): AiSettings;
  /**
   * Provider `id` for `settings`' choice, cancelled when this activation ends; throws, naming why, while it can't run.
   * Completions declare `reads`, checked as sent (LocalOnlyError).
   */
  provider(id: ProviderId, settings?: AiSettings): PluginProvider;
  /** Picks the channels a provider or Jev may be sent, before a request declares them. */
  sources: AiSources;
  /** Every provider and account, with why each cannot run. */
  providers(): ProviderInfo[];
  /** Why provider `id` can't run now (its plugin is off or absent, or it is turned off in Settings → AI); null while it can. */
  unavailable(id: ProviderId): string | null;
  /** Whether provider `id` runs on this PC, so channels set to local AI only may use it. */
  isLocal(id: ProviderId): boolean;
  /** Supplies a provider this plugin declares, until the plugin turns off. */
  registerProvider(id: ProviderIds<D>, impl: ProviderImpl): void;
  /** Legacy key reader; the ProviderAccount passed to create/status supplies its own apiKey(). */
  apiKey(id: ProviderId): string | null;
  /** A call's cost at the model's API list rates (OpenRouter id), for plan-paid providers; undefined when unknown or off. */
  apiCost: PriceAtApiRates;
  /** The host's OpenRouter keys, for a provider declared as paid through them. */
  openRouterKeys: OpenRouterKeyReader;
  usage: { provide(read: UsageReader): void };
  /** Settings → AI or Settings → Jev was saved. */
  onSettingsChange(fn: () => void): void;
}

const UNLOADED = 'Plugin is unloaded.';
const NO_USAGE = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

/** Builds a plugin's AI services; `ask` runs plugin code with a fallback, `guard` records a plugin's throw. */
export function pluginAi<D extends PluginDescriptor>(
  plugin: D,
  bundled: BundledDeps,
  reg: Registrations,
  /** The activation's lifetime: what it hands out is cancelled when it ends. */
  lifetime: AbortSignal,
  ask: <T>(fn: () => T, fallback: T) => T,
  guard: (fn: () => unknown) => void,
): PluginAi<D> {
  const live = (): boolean => servicesLive(reg);
  const { providers } = bundled;
  const checked = async <T>(job: () => Promise<T>, key: string | null): Promise<T> => {
    try {
      return await job();
    } catch (err) {
      const safe = keyError(err, key);
      guard(() => { throw safe; });
      throw safe;
    }
  };
  /** Why `id` can't run for this plugin: its plugin can't, or the owner hasn't added it or turned its account off in Settings → AI. */
  const unavailable = (id: ProviderId, settings: AiSettings = bundled.aiSettings()): string | null =>
    providers.unavailable(id) ?? offReason(id, settings);
  return {
    settings: bundled.aiSettings,
    provider: (id, settings = bundled.aiSettings()) => {
      const why = unavailable(id, settings);
      if (why) throw new ProviderUnavailableError(why);
      return scopedProvider(revocable(providers.get(id, settings), lifetime), (reads) => assertProviderMayRead(bundled.ready(), providers, id, reads));
    },
    sources: aiSources(() => bundled.ready(), (id) => providers.isLocal(id)),
    providers: () => providers.providers().map((p) => ({ ...p, unavailable: unavailable(p.id) })),
    unavailable: (id) => unavailable(id),
    isLocal: (id) => providers.isLocal(id),
    apiKey: (id) => {
      const declared = plugin.providers?.find((p) => p.id === accountProvider(id));
      if (!declared) throw new Error(`${plugin.manifest.id} reads AI provider ${id} but declares none`);
      if (!declared.apiKey) throw new Error(`${plugin.manifest.id} reads API key for ${id} but declares no apiKey`);
      return live() ? providers.apiKey(id) : null;
    },
    registerProvider: (id, impl) => {
      if (!plugin.providers?.some((p) => p.id === id)) throw new Error(`${plugin.manifest.id} registers AI provider ${id} but declares none`);
      if (!live()) return;
      reg.registered.add(registration('AI provider', id));
      reg.disposers.push(
        providers.register(id, {
          create: (choice, account) => impl.create(choice, account),
          // A throwing report is recorded on the plugin; Settings → AI shows its message as the reason.
          status: (choice, refresh, account) => checked(() => impl.status(choice, refresh, account), account.apiKey()),
          ...(impl.checkApiKey ? { checkApiKey: (key: string) => checked(() => impl.checkApiKey!(key), key) } : {}),
          ...(impl.linkAccount ? { linkAccount: (account, io) => checked(() => impl.linkAccount!(account, io), account.apiKey()) } : {}),
          ...(impl.removeAccount ? { removeAccount: (account) => checked(() => impl.removeAccount!(account), account.apiKey()) } : {}),
          ...(impl.dispose ? { dispose: () => impl.dispose!() } : {}),
        }, bundled.pluginData.unmoved[plugin.manifest.id] ?? join(bundled.pluginData.root, plugin.manifest.id)),
      );
    },
    apiCost: (model, usage) => (live() ? apiCost(model, usage) : Promise.resolve(undefined)),
    openRouterKeys: {
      forModel: (model) => (live() ? providers.openRouterKeys.forModel(model) : null),
      count: () => (live() ? providers.openRouterKeys.count() : 0),
      balance: (key) => (live() ? providers.openRouterKeys.balance(key) : Promise.reject(new Error(UNLOADED))),
    },
    usage: {
      provide: (read) => {
        if (live()) reg.disposers.push(registerUsage((provider, sinceTs) => ask(() => read(provider, sinceTs), NO_USAGE)));
      },
    },
    // Settings → Jev is stored in the AI settings.
    onSettingsChange: (fn) => void reg.onSettingChanged.push({ key: SETTINGS_KEYS.ai, fn }),
  };
}
