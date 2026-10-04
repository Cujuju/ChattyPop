// The host's AI registry (docs/plugin-architecture.md §3, AI providers): providers plugins register, keyed by declared id,
// and Jev, which stays in the host with the OpenRouter and TypeSafe keys it is paid through.
import type { JevStatus, ProviderStatus } from '@shared/contract';
import { declaredProvider, declaredProviders, providerUnavailable, type DeclaredProvider } from '@shared/aiProviders';
import { errorMessage } from '@shared/errors';
import { NONE_STARTED, type PluginStates } from '@shared/ruleAvailability';
import { JEV_OPENROUTER_MODEL, keyForModel, keyHint, type OpenRouterKeyBalance, type OpenRouterKeyEntry, type OpenRouterKeyInfo } from '@shared/openrouter';
import { jevFeatureOn, type AiSettings, type JevFeature, type ProviderId } from '@shared/settings';
import type { DecisionProvider } from './decisions';
import { JevProvider, openRouterJevRoute, typeSafeJevRoute, type JevRoute, type JevSpent } from './jev';
import { openRouterKeyBalance } from './openRouterKeys';
import { revocable } from './revocable';
import {
  ProviderUnavailableError,
  chosenModel,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type PlanUsageWindow,
  type ProviderChoice,
  type ProviderImpl,
  type ProviderInfo,
} from './types';

/** A provider not declared to read images refuses a request carrying some, rather than answering without them. */
function withoutImages(p: LlmProvider, label: string): LlmProvider {
  return {
    id: p.id,
    maxInputChars: p.maxInputChars,
    complete: (req) => (req.images?.length ? Promise.reject(new Error(`${label} can't read images.`)) : p.complete(req)),
    listModels: () => p.listModels(),
    ...(p.planUsage ? { planUsage: () => p.planUsage!() } : {}),
  };
}

/** A provider's choice when Settings → AI holds none for it: the provider's own defaults. */
const NO_CHOICE: ProviderChoice = { model: null, effort: null };
/** A declared provider whose plugin runs but hasn't registered it (mid-activation, or the plugin never does). */
const notRegistered = (label: string, plugin: string): string => `The ${plugin} plugin is on but hasn't registered ${label}.`;
/** The host's OpenRouter keys as a provider paid through them reads them; secrets stay in core memory. */
export interface OpenRouterKeyReader {
  /** The key that pays for `model`: the one listing it, else the any-model key, else null. */
  forModel(model: string): OpenRouterKeyEntry | null;
  /** How many keys are stored. */
  count(): number;
  /** A key's own cap and spend, as OpenRouter reports them. */
  balance(key: OpenRouterKeyEntry): Promise<OpenRouterKeyBalance>;
}

/** A provider's registration; aborting `revoked` revokes every provider it handed out. */
interface Registration {
  impl: ProviderImpl;
  revoked: AbortController;
}

export class ProviderRegistry {
  private readonly registered = new Map<ProviderId, Registration>();
  private pluginStates: PluginStates = NONE_STARTED;
  /** Held in memory only; main owns the encrypted copy on disk. */
  private openRouterKeyList: OpenRouterKeyEntry[] = [];
  /** For connecting to Jev directly; held in memory only, like the OpenRouter keys. */
  private typeSafeKey: string | null = null;
  /** One instance: its in-flight cap covers every Jev caller, and every request it answers reaches `jevSpent`. Jev bills to the key that lists it. */
  private readonly jev: JevProvider;

  constructor(
    jevSpent: JevSpent,
    /** The providers plugins may register: this build's declarations. */
    private readonly declared: readonly DeclaredProvider[] = declaredProviders(),
  ) {
    this.jev = new JevProvider(jevSpent);
  }

  /** Adds a declared provider until the returned disposer runs (its plugin turns off), which revokes what it handed out. */
  register(id: ProviderId, impl: ProviderImpl): () => void {
    if (!declaredProvider(id, this.declared)) throw new Error(`No AI provider ${id} is declared in this build.`);
    if (this.registered.has(id)) throw new Error(`AI provider ${id} is already registered.`);
    const registration: Registration = { impl, revoked: new AbortController() };
    this.registered.set(id, registration);
    return () => {
      if (this.registered.get(id) !== registration) return;
      this.registered.delete(id);
      registration.revoked.abort(new ProviderUnavailableError(this.unavailable(id)!));
    };
  }

  /** Whether provider `id` can take requests now. */
  runs(id: ProviderId): boolean {
    return this.registered.has(id);
  }

  /** Settings → Plugins' states, so a reason tells an off plugin from one that failed to start. The plugin host binds it. */
  bindPlugins(states: PluginStates): void {
    this.pluginStates = states;
  }

  /** Why provider `id` can't take requests now; null while it can. */
  unavailable(id: ProviderId): string | null {
    if (this.runs(id)) return null;
    const declared = declaredProvider(id, this.declared);
    const reason = providerUnavailable(id, this.pluginStates, this.declared);
    // Null only for a declared provider whose plugin runs.
    return reason ?? notRegistered(declared!.label, declared!.plugin.name);
  }

  /** Every declared provider, with why each can't run now. */
  providers(): ProviderInfo[] {
    return this.declared.map(({ plugin: _owner, ...d }) => ({ ...d, unavailable: this.unavailable(d.id) }));
  }

  /** Whether provider `id` runs on this PC (local AI only channels may use it). */
  isLocal(id: ProviderId): boolean {
    return declaredProvider(id, this.declared)?.local === true;
  }

  /** The provider for `settings`' choice; throws ProviderUnavailableError, naming why, while it can't run. */
  get(id: ProviderId, settings: AiSettings): LlmProvider {
    const registration = this.registered.get(id);
    if (!registration) throw new ProviderUnavailableError(this.unavailable(id)!);
    const provider = revocable(registration.impl.create(settings.providers[id] ?? NO_CHOICE), registration.revoked.signal);
    const d = declaredProvider(id, this.declared)!;
    return d.images ? provider : withoutImages(provider, d.label);
  }

  /** Settings → AI: each running provider's state, in declared order. A failing report is shown as the reason. */
  async status(settings: AiSettings, refresh = false): Promise<ProviderStatus[]> {
    const running = this.declared.flatMap((d) => {
      const impl = this.registered.get(d.id)?.impl;
      return impl ? [{ id: d.id, impl }] : [];
    });
    return Promise.all(
      running.map(async ({ id, impl }): Promise<ProviderStatus> => {
        try {
          return { id, ...(await impl.status(settings.providers[id] ?? NO_CHOICE, refresh)) };
        } catch (err) {
          return { id, available: false, detail: errorMessage(err), models: null };
        }
      }),
    );
  }

  planUsage(id: ProviderId, settings: AiSettings): Promise<PlanUsageWindow[] | null> {
    return this.get(id, settings).planUsage?.() ?? Promise.resolve(null);
  }

  setOpenRouterKeys(keys: OpenRouterKeyEntry[]): void {
    this.openRouterKeyList = keys;
  }

  setTypeSafeKey(key: string | null): void {
    this.typeSafeKey = key;
  }

  /** The stored OpenRouter keys, for a provider paid through them. */
  readonly openRouterKeys: OpenRouterKeyReader = {
    forModel: (model) => keyForModel(this.openRouterKeyList, model),
    count: () => this.openRouterKeyList.length,
    balance: (key) => openRouterKeyBalance(key.key),
  };

  /** Where Jev requests go on the chosen connection; null when that connection has no key. Never falls back to the other one. */
  private jevRoute(settings: AiSettings): JevRoute | null {
    if (settings.jevConnection === 'typesafe') return this.typeSafeKey ? typeSafeJevRoute(this.typeSafeKey) : null;
    const key = keyForModel(this.openRouterKeyList, JEV_OPENROUTER_MODEL);
    return key ? openRouterJevRoute(key) : null;
  }

  keyInfos(): OpenRouterKeyInfo[] {
    return this.openRouterKeyList.map(({ key: _secret, ...info }) => info);
  }

  async keyBalances(): Promise<Record<string, OpenRouterKeyBalance | { error: string }>> {
    const entries = await Promise.all(
      this.openRouterKeyList.map(async (k) => [k.id, await openRouterKeyBalance(k.key).catch((err: unknown) => ({ error: errorMessage(err) }))] as const),
    );
    return Object.fromEntries(entries);
  }

  /** Jev for a feature the user turned on, or null (feature off or the chosen connection has no key). */
  decider(settings: AiSettings, feature: JevFeature): DecisionProvider | null {
    const route = jevFeatureOn(settings.jev, feature) ? this.jevRoute(settings) : null;
    return route ? this.jev.via(route) : null;
  }

  jevStatus(settings: AiSettings): JevStatus {
    const route = this.jevRoute(settings);
    return {
      available: route !== null,
      connection: settings.jevConnection,
      model: this.jev.model,
      keyLabel: route?.label ?? null,
      typeSafeKeyHint: this.typeSafeKey ? keyHint(this.typeSafeKey) : null,
      lastError: this.jev.lastError,
    };
  }
}
