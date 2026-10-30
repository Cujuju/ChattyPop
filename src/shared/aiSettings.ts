// AI settings: providers, Jev features and routing. Stored JSON is normalized on read (see settings.ts).
import { bool, isObj, oneOf, textOrNull } from './normalize';
import { PLUGIN_ID_SOURCE } from './plugins';
import { ACCOUNT_ID, ACCOUNT_KEY_SOURCE, ACCOUNT_SEPARATOR, DECLARED_PROVIDER_SOURCE, accountKey, accountProvider, isAccountAuth, type ProviderAccountSettings } from './providerAccounts';

/** A declared provider id or an owner-added account id (docs/plugin-architecture.md §3). */
export type ProviderId = string;
/** The shape of a provider id; stored choices keep any id of this shape, whether or not this build has its plugin. */
export const PROVIDER_ID = new RegExp(`^${DECLARED_PROVIDER_SOURCE}(${ACCOUNT_SEPARATOR}${ACCOUNT_KEY_SOURCE})?$`);
/** A stored provider choice: an id of provider shape, else null. */
export const normalizeProviderId = (v: unknown): ProviderId | null => (typeof v === 'string' && PROVIDER_ID.test(v) ? v : null);

/** What normalizing needs of a declared provider: its id. It is off until the owner adds it. */
export interface ProviderDefaults {
  id: ProviderId;
}

/** Names for effort levels providers report; an unknown level shows as reported. */
export const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  on: 'On',
  off: 'Off',
};

/** Provider label length limit for usage headings. */
export const PROVIDER_DISPLAY_NAME_MAX = 20;

export interface ProviderSettings {
  /** Takes requests. Off keeps the provider listed in Settings → AI with its choices. */
  enabled: boolean;
  /** A declared provider is listed in Settings → AI (an account is listed while stored). Absent before the owner could switch one off: it follows `enabled`. */
  added?: boolean;
  /** Model id; null = the provider's own default. */
  model: string | null;
  /** Thinking/effort level, one of the model's ModelOption.efforts; null = the provider's own default. */
  effort: string | null;
  /** The owner's display name for the provider; null = its declared display name. */
  displayName: string | null;
  /** Sends its requests through the owner's proxy (AiSettings.proxy) when its provider declares `proxy`. */
  proxy: boolean;
}

/** A provider's settings in a profile that never set them: not added, off, every choice the provider's default. */
export const UNSET_PROVIDER_SETTINGS: Readonly<ProviderSettings> = { enabled: false, added: false, model: null, effort: null, displayName: null, proxy: false };

/** The owner's proxy for providers switched to it; its client key is a host secret, never stored here. */
export interface AiProxySettings {
  /** http(s) base address without a trailing slash; null = none set. */
  url: string | null;
}

/** Schemes a proxy address may use: one on this PC or the LAN rarely has a certificate. */
const PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** A stored or typed proxy address: an http(s) URL without its trailing slash, else null. */
export function normalizeProxyUrl(v: unknown): string | null {
  const text = textOrNull(v);
  if (!text || !URL.canParse(text)) return null;
  const url = new URL(text);
  return PROXY_PROTOCOLS.has(url.protocol) ? url.href.replace(/\/+$/, '') : null;
}


/** How Jev requests reach TypeSafe: through an OpenRouter key that lists Jev, or directly with a TypeSafe key. */
export const JEV_CONNECTIONS = ['openrouter', 'typesafe'] as const;
export type JevConnection = (typeof JEV_CONNECTIONS)[number];

/** Opt-in host Jev switches control meaning, badges, retention, tags, suggestions, plugin decisions, checks, classes, rule questions and conversation links. */
export const HOST_JEV_FEATURES = [
  'topicMeaning',
  'catchUpBadges',
  'keepImportant',
  'messageTags',
  'suggestChannels',
  'pluginDecide',
  'messageCheck',
  'messageClasses',
  'ruleQuestions',
  'linkConversations',
] as const;
export type HostJevFeature = (typeof HOST_JEV_FEATURES)[number];
/** A plugin's switch as stored and asked for: `<plugin id>.<its key>` (descriptor `jev.features`), stamped by the host. */
export type PluginJevFeature = `${string}.${string}`;
/** A Settings → Jev switch: the host's, or a plugin's stamped key. */
export type JevFeature = HostJevFeature | PluginJevFeature;
/** Whether `f` is one of the host's switches (unprefixed); a plugin's are stamped. */
export const isHostJevFeature = (f: string): f is HostJevFeature => (HOST_JEV_FEATURES as readonly string[]).includes(f);

/** Preserves all stored host/plugin/unknown switches when saving, including absent or unadopted plugin keys. */
export type JevSettings = Record<HostJevFeature, boolean> & Partial<Record<PluginJevFeature, boolean>>;

/** What normalizing needs of a declared plugin switch: its stamped key and its value in a profile that never set it. */
export interface JevFeatureDefaults {
  key: JevFeature;
  default: boolean;
}

/** A stored switch key worth keeping: an identifier, a plugin's stamped one included. */
const JEV_FEATURE_KEY = new RegExp(`^(${PLUGIN_ID_SOURCE}\\.)?[a-zA-Z][a-zA-Z0-9_]*$`);

/** Retired host switch keys and the switch each became; read once into it, then dropped. */
const RETIRED_JEV_FEATURES: Readonly<Record<string, HostJevFeature>> = {
  // Topics' own-question switch became rules' one.
  customQuestions: 'ruleQuestions',
};

/** Whether switch `f` is on; a switch this build doesn't declare is off. */
export const jevFeatureOn = (jev: JevSettings, f: JevFeature): boolean => jev[f] ?? false;

export interface AiSettings {
  /** Owner-added accounts in Settings order; their choices and names are in providers[id]. */
  accounts: ProviderAccountSettings[];
  /** Every stored provider's settings, kept whether or not its plugin is in this build, plus declared defaults. */
  providers: Record<ProviderId, ProviderSettings>;
  /** Commands the owner types in Discord, answered there. */
  jev: JevSettings;
  jevConnection: JevConnection;
  proxy: AiProxySettings;
}


export const DEFAULT_AI_SETTINGS: AiSettings = {
  accounts: [],
  // No provider is known without the build's declarations (normalizeAiSettings adds them).
  providers: {},

  // OpenRouter was Jev's first and only connection; existing setups keep it.
  jevConnection: 'openrouter',
  // Host switches all off (opt-in); plugin switches take their declared defaults (normalizeAiSettings).
  jev: Object.fromEntries(HOST_JEV_FEATURES.map((f) => [f, false] as const)) as JevSettings,
  proxy: { url: null },
};

/** Trimmed and capped at PROVIDER_DISPLAY_NAME_MAX; blank = null (use the default). */
export const normalizeDisplayName = (v: unknown): string | null => textOrNull(v)?.slice(0, PROVIDER_DISPLAY_NAME_MAX) ?? null;

/** One stored provider's settings; `enabled` falls back to `unsetEnabled`. */
function providerSettings(v: unknown, unsetEnabled: boolean): ProviderSettings {
  const p = isObj(v) ? v : {};
  return {
    enabled: bool(p['enabled'], unsetEnabled),
    added: bool(p['added'], bool(p['enabled'], unsetEnabled)),
    model: textOrNull(p['model'], false),
    effort: textOrNull(p['effort']),
    // 'shortName': this field's first stored key.
    displayName: normalizeDisplayName(p['displayName'] ?? p['shortName']),
    proxy: bool(p['proxy'], false),
  };
}

/** Preserves stored providers/switches across absent-plugin builds. A declared provider is unlisted and off until the owner adds it; an account is on unless paused. */
export function normalizeAiSettings(v: unknown, declared: readonly ProviderDefaults[] = [], features: readonly JevFeatureDefaults[] = []): AiSettings {
  const src = isObj(v) ? v : {};
  const stored = isObj(src['providers']) ? src['providers'] : {};
  const providers: Record<ProviderId, ProviderSettings> = {};
  for (const [id, p] of Object.entries(stored)) if (PROVIDER_ID.test(id) && isObj(p)) providers[id] = providerSettings(p, false);
  for (const d of declared) providers[d.id] = providerSettings(stored[d.id], false);
  const accounts: ProviderAccountSettings[] = [];
  for (const a of Array.isArray(src['accounts']) ? src['accounts'] : []) {
    if (!isObj(a) || typeof a['id'] !== 'string' || !ACCOUNT_ID.test(a['id']) || !isAccountAuth(a['auth'])) continue;
    const id = a['id'];
    const plugin = accountProvider(id).split('.')[0];
    if (accounts.some((p) => accountProvider(p.id).split('.')[0] === plugin && accountKey(p.id) === accountKey(id))) continue;
    accounts.push({ id, auth: a['auth'] });
    providers[id] = providerSettings(stored[id], true);
  }
  const out: AiSettings = {
    accounts,
    providers,
    jevConnection: oneOf(JEV_CONNECTIONS, src['jevConnection'], DEFAULT_AI_SETTINGS.jevConnection),
    jev: { ...DEFAULT_AI_SETTINGS.jev },
    proxy: { url: normalizeProxyUrl(isObj(src['proxy']) ? src['proxy']['url'] : null) },
  };
  const jev = isObj(src['jev']) ? src['jev'] : {};
  const kept = out.jev as Record<string, boolean>;
  for (const [f, on] of Object.entries(jev)) if (typeof on === 'boolean' && JEV_FEATURE_KEY.test(f) && !Object.hasOwn(RETIRED_JEV_FEATURES, f)) kept[f] = on;
  for (const f of HOST_JEV_FEATURES) out.jev[f] = bool(jev[f], false);
  for (const d of features) out.jev[d.key] = bool(jev[d.key], d.default);
  for (const [retired, f] of Object.entries(RETIRED_JEV_FEATURES)) out.jev[f] ||= bool(jev[retired], false);
  return out;
}
