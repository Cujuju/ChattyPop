// Registers plugin AI providers by declared id; host Jev uses its OpenRouter or TypeSafe keys.
import type { AppEvent, JevStatus, ProviderStatus } from '@shared/contract';
import { accountUnavailable, declaredProvider, declaredProviders, providersOf, providerUnavailable, proxyUnavailable, proxyUrl, type DeclaredProvider } from '@shared/aiProviders';
import { errorMessage } from '@shared/errors';
import { NONE_STARTED, type PluginStates } from '@shared/ruleAvailability';
import { JEV_OPENROUTER_MODEL, keyForModel, keyHint, type OpenRouterKeyBalance, type OpenRouterKeyEntry, type OpenRouterKeyInfo } from '@shared/openrouter';
import { jevFeatureOn, type AiSettings, type JevFeature, type ProviderId } from '@shared/settings';
import { accountKey, accountProvider } from '@shared/providerAccounts';
import { ProviderAccounts } from './accounts';
import type { DecisionProvider } from './decisions';
import { JevProvider, openRouterJevRoute, typeSafeJevRoute, type JevRoute, type JevSpent } from './jev';
import { openRouterKeyBalance } from './openRouterKeys';
import { completionContract, revocable } from './revocable';
import { checkToolRequest } from './toolRequest';
import { keyError, keyedProvider, redactKey } from './keyError';
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
  type ProviderProxy,
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

/** A provider not declared to call tools refuses a request carrying some. */
function withoutTools(p: LlmProvider, label: string): LlmProvider {
  return {
    ...p,
    complete: (req) => (req.tools?.length ? Promise.reject(new Error(`${label} can't call tools.`)) : p.complete(req)),
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
  private readonly accounts = new ProviderAccounts((id) => this.apiKey(id), (id) => this.proxy(id));
  private readonly registered = new Map<ProviderId, Registration>();
  private pluginStates: PluginStates = NONE_STARTED;
  /** Held in memory only; main owns the encrypted copy on disk. */
  private openRouterKeyList: OpenRouterKeyEntry[] = [];
  /** For connecting to Jev directly; held in memory only, like the OpenRouter keys. */
  private typeSafeKey: string | null = null;
  private providerApiKeys: Readonly<Record<ProviderId, string>> = {};
  /** The proxy's client key; held in memory only, like the provider keys. */
  private proxyKey: string | null = null;
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
  register(id: ProviderId, impl: ProviderImpl, dataDir?: string): () => void {
    const declared = accountKey(id) ? null : declaredProvider(id, this.declared);
    if (!declared) throw new Error(`No AI provider ${id} is declared in this build.`);
    if (declared.apiKey && !impl.checkApiKey) throw new Error(`AI provider ${id} declares apiKey but supplies no checkApiKey.`);
    if (declared.accounts?.signIn && !impl.linkAccount) throw new Error(`AI provider ${id} declares signIn accounts but supplies no linkAccount.`);
    if (declared.accounts && !dataDir) throw new Error(`AI provider ${id} accounts require plugin storage.`);
    if (this.registered.has(id)) throw new Error(`AI provider ${id} is already registered.`);
    const registration: Registration = { impl, revoked: new AbortController() };
    this.registered.set(id, registration);
    // Only a provider declaring accounts owns account folders in its plugin's data folder.
    if (declared.accounts && dataDir) this.accounts.activate(id, impl, dataDir);
    // Revokes before the plugin's own cleanup, so a throw from that cleanup leaves nothing registered or running.
    return () => {
      if (this.registered.get(id) !== registration) return;
      this.registered.delete(id);
      this.accounts.deactivate(id);
      registration.revoked.abort(new ProviderUnavailableError(this.unavailable(id)!));
      impl.dispose?.();
    };
  }

  /** Whether provider `id` can take requests now. */
  runs(id: ProviderId): boolean {
    const ai = this.accounts.current();
    return !accountUnavailable(id, ai, this.declared) && !proxyUnavailable(id, ai, this.declared) && this.registered.has(accountProvider(id));
  }

  /** Settings → Plugins' states, so a reason tells an off plugin from one that failed to start. The plugin host binds it. */
  bindPlugins(states: PluginStates): void {
    this.pluginStates = states;
  }

  /** Why provider `id` can't take requests now; null while it can. */
  unavailable(id: ProviderId): string | null {
    const accountReason = accountUnavailable(id, this.accounts.current(), this.declared) ?? proxyUnavailable(id, this.accounts.current(), this.declared);
    if (accountReason) return accountReason;
    if (this.runs(id)) return null;
    const declared = declaredProvider(id, this.declared);
    const reason = providerUnavailable(id, this.pluginStates, this.declared, this.accounts.current());
    // Null only for a declared provider whose plugin runs.
    return reason ?? notRegistered(declared!.label, declared!.plugin.name);
  }

  /** Every declaration and account, with why each cannot run. */
  providers(): ProviderInfo[] {
    return providersOf(this.accounts.current(), this.declared).map(({ plugin: _owner, ...d }) => ({ ...d, unavailable: this.unavailable(d.id) }));
  }

  /** Whether provider `id` runs on this PC (local AI only channels may use it). */
  isLocal(id: ProviderId): boolean {
    return declaredProvider(id, this.declared)?.local === true;
  }

  /** The provider for `settings`' choice; throws ProviderUnavailableError, naming why, while it can't run. */
  get(id: ProviderId, settings: AiSettings): LlmProvider {
    this.accounts.sync(settings);
    const why = this.unavailable(id);
    if (why) throw new ProviderUnavailableError(why);
    const registration = this.registered.get(accountProvider(id));
    if (!registration) throw new ProviderUnavailableError(this.unavailable(id)!);
    const held = this.accounts.get(id);
    const raw = registration.impl.create(settings.providers[id] ?? NO_CHOICE, held.account);
    const named: LlmProvider = { id, maxInputChars: raw.maxInputChars, complete: (req) => raw.complete(req), listModels: () => raw.listModels(), ...(raw.planUsage ? { planUsage: () => raw.planUsage!() } : {}) };
    const revoking = revocable(revocable(completionContract(named), held.revoked.signal), registration.revoked.signal);
    const provider = keyedProvider(keyedProvider(revoking, () => this.apiKey(id)), () => this.proxyKey);
    const d = declaredProvider(id, this.declared)!;
    const images = d.images ? provider : withoutImages(provider, d.label);
    const tools = d.tools ? images : withoutTools(images, d.label);
    return { ...tools, complete: async (req) => tools.complete(checkToolRequest(req)) };
  }

  /** Settings → AI: each running provider's state, in declared order. A failing report is shown as the reason. */
  async status(settings: AiSettings, refresh = false): Promise<ProviderStatus[]> {
    this.accounts.sync(settings);
    const stored = this.accounts.current();
    const running = providersOf(stored, this.declared).filter((d) => this.registered.has(accountProvider(d.id)));
    return Promise.all(running.map(async ({ id }): Promise<ProviderStatus> => {
      const impl = this.registered.get(accountProvider(id))!.impl;
      const account = this.accounts.get(id).account;
      const storedKey = declaredProvider(id, this.declared)?.apiKey ? Object.hasOwn(this.providerApiKeys, id) ? this.providerApiKeys[id]! : null : null;
      const apiKeyHint = storedKey ? keyHint(storedKey) : null;
      const accountReason = accountUnavailable(id, stored, this.declared) ?? proxyUnavailable(id, stored, this.declared);
      if (accountReason) return { id, auth: account.auth, apiKeyHint, available: false, detail: accountReason, models: null };
      try {
        const report = await impl.status(settings.providers[id] ?? NO_CHOICE, refresh, account);
        return {
          id, auth: account.auth, apiKeyHint, available: report.available,
          detail: redactKey(redactKey(report.detail, storedKey), this.proxyKey), models: report.models,
          ...(account.auth === 'signIn' && report.signedIn !== undefined ? { signedIn: report.signedIn } : {}),
        };
      } catch (err) {
        return { id, auth: account.auth, apiKeyHint, available: false, detail: keyError(keyError(err, storedKey), this.proxyKey).message, models: null };
      }
    }));
  }

  planUsage(id: ProviderId, settings: AiSettings): Promise<PlanUsageWindow[] | null> {
    const provider = this.get(id, settings);
    // An API key has no plan, whatever its provider answers.
    if (!provider.planUsage || this.accounts.get(id).account.auth === 'apiKey') return Promise.resolve(null);
    return provider.planUsage();
  }

  setOpenRouterKeys(keys: OpenRouterKeyEntry[]): void {
    this.openRouterKeyList = keys;
  }

  setTypeSafeKey(key: string | null): void {
    this.typeSafeKey = key;
  }

  /** Held in memory only; main owns the encrypted copy on disk. Keyed by provider id. */
  setProviderApiKeys(keys: Readonly<Record<ProviderId, string>>): void {
    this.providerApiKeys = { ...keys };
  }

  /** Held in memory only; main owns the encrypted copy on disk. Null: none stored. */
  setProxyKey(key: string | null): void {
    this.proxyKey = key;
  }

  /** Last characters of the stored proxy client key; null when none is stored. */
  proxyKeyHint(): string | null {
    return this.proxyKey ? keyHint(this.proxyKey) : null;
  }

  /** The proxy provider `id` sends through now; null: straight to its vendor. */
  proxy(id: ProviderId): ProviderProxy | null {
    const url = proxyUrl(id, this.accounts.current(), this.declared);
    return url ? { url, key: this.proxyKey } : null;
  }

  /** An existing API-key account's current key; declarations and orphan keys are unused. */
  apiKey(id: ProviderId): string | null {
    const stored = this.accounts.current().accounts.find((a) => a.id === id);
    return stored?.auth === 'apiKey' && !accountUnavailable(id, this.accounts.current(), this.declared) && declaredProvider(id, this.declared)?.apiKey && Object.hasOwn(this.providerApiKeys, id) ? this.providerApiKeys[id]! : null;
  }

  /** Checks a key with its declared, running provider before main stores it. */
  async checkApiKey(id: ProviderId, key: string): Promise<void> {
    if (!this.accounts.current().accounts.some((a) => a.id === id && a.auth === 'apiKey') || accountUnavailable(id, this.accounts.current(), this.declared) || !declaredProvider(id, this.declared)?.apiKey) throw new Error(`AI provider ${id} is not an existing API-key account.`);
    const impl = this.registered.get(accountProvider(id))?.impl;
    if (!impl) throw new ProviderUnavailableError(this.unavailable(id)!);
    if (!impl.checkApiKey) throw new Error(`AI provider ${id} supplies no checkApiKey.`);
    try {
      await impl.checkApiKey(key);
    } catch (err) {
      throw keyError(err, key);
    }
  }

  bindAccounts(settings: () => AiSettings, emit: (event: AppEvent) => void): void { this.accounts.bind(settings, emit); }
  accountsChanged(settings: AiSettings): Promise<void> { this.accounts.sync(settings); return this.accounts.settled(); }
  linkAccount(id: ProviderId): void {
    const why = this.unavailable(id);
    if (why) throw new ProviderUnavailableError(why);
    this.accounts.links.start(this.accounts.get(id).account, this.registered.get(accountProvider(id))!.impl);
  }
  submitLinkCode(id: ProviderId, code: string): void { this.accounts.get(id); this.accounts.links.submit(id, code); }
  cancelLink(id: ProviderId): void { this.accounts.get(id); this.accounts.links.cancel(id); }

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
