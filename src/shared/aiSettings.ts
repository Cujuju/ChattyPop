// AI settings: providers, Jev features and routing. Stored JSON is normalized on read (see settings.ts).
import { bool, isObj, oneOf, textOrNull } from './normalize';
import { PLUGIN_ID_SOURCE } from './plugins';

/** A registered AI provider's id (docs/plugin-architecture.md §3, AI providers): its plugin's id, or `<plugin id>.<name>`. */
export type ProviderId = string;
/** The shape of a provider id; stored choices keep any id of this shape, whether or not this build has its plugin. */
export const PROVIDER_ID = new RegExp(`^${PLUGIN_ID_SOURCE}(\\.[a-zA-Z][a-zA-Z0-9_]*)?$`);
/** A stored provider choice: an id of provider shape, else null. */
export const normalizeProviderId = (v: unknown): ProviderId | null => (typeof v === 'string' && PROVIDER_ID.test(v) ? v : null);

/** What normalizing needs of a declared provider: its id and whether a profile that never set it has it on. */
export interface ProviderDefaults {
  id: ProviderId;
  enabledByDefault: boolean;
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

/** Longer names crowd Plan usage's provider headings. */
export const PROVIDER_DISPLAY_NAME_MAX = 20;

export interface ProviderSettings {
  enabled: boolean;
  /** Model id; null = the provider's own default. */
  model: string | null;
  /** Thinking/effort level, one of the model's ModelOption.efforts; null = the provider's own default. */
  effort: string | null;
  /** The owner's display name for the provider; null = its declared display name. */
  displayName: string | null;
}


/** How Jev requests reach TypeSafe: through an OpenRouter key that lists Jev, or directly with a TypeSafe key. */
export const JEV_CONNECTIONS = ['openrouter', 'typesafe'] as const;
export type JevConnection = (typeof JEV_CONNECTIONS)[number];

/**
 * The host's Settings → Jev switches, in the order Settings lists them within their groups. Each sends message text to TypeSafe (through
 * OpenRouter or directly), so each is opt-in.
 * - topicMeaning: rules match by meaning (a described subject); key kept from when topics did.
 * - catchUpBadges: channels show how many notable messages arrived since they were last opened.
 * - keepImportant: text retention keeps notable messages verbatim.
 * - messageTags: messages are tagged (question, announcement, plan, decision…).
 * - suggestChannels: suggests which channels to archive, from your rules.
 * - pluginDecide: plugins may ask Jev through ai.decide().
 * - messageCheck: right-click a message for a Jev check, including your own questions.
 * - messageClasses: messages are labelled political, finance or trading.
 * - ruleQuestions: rules matching by the owner's own Jev question ask it about each message in scope.
 */
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
] as const;
export type HostJevFeature = (typeof HOST_JEV_FEATURES)[number];
/** A plugin's switch as stored and asked for: `<plugin id>.<its key>` (descriptor `jev.features`), stamped by the host. */
export type PluginJevFeature = `${string}.${string}`;
/** A Settings → Jev switch: the host's, or a plugin's stamped key. */
export type JevFeature = HostJevFeature | PluginJevFeature;
/** Whether `f` is one of the host's switches (unprefixed); a plugin's are stamped. */
export const isHostJevFeature = (f: string): f is HostJevFeature => (HOST_JEV_FEATURES as readonly string[]).includes(f);

/**
 * The switches' stored values: every host switch, each declared plugin switch, and whatever else was stored (a switch
 * of a plugin absent from this build or not yet adopted), kept so saving never drops it.
 */
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
  /** Every stored provider's settings, kept whether or not its plugin is in this build, plus declared defaults. */
  providers: Record<ProviderId, ProviderSettings>;
  /** Commands the owner types in Discord, answered there. */
  jev: JevSettings;
  jevConnection: JevConnection;
}


export const DEFAULT_AI_SETTINGS: AiSettings = {
  // No provider is known without the build's declarations (normalizeAiSettings adds them).
  providers: {},

  // OpenRouter was Jev's first and only connection; existing setups keep it.
  jevConnection: 'openrouter',
  // Host switches all off (opt-in); plugin switches take their declared defaults (normalizeAiSettings).
  jev: Object.fromEntries(HOST_JEV_FEATURES.map((f) => [f, false] as const)) as JevSettings,
};

/** Trimmed and capped at PROVIDER_DISPLAY_NAME_MAX; blank = null (use the default). */
export const normalizeDisplayName = (v: unknown): string | null => textOrNull(v)?.slice(0, PROVIDER_DISPLAY_NAME_MAX) ?? null;

/** One stored provider's settings; `enabled` falls back to `enabledByDefault`. */
function providerSettings(v: unknown, enabledByDefault: boolean): ProviderSettings {
  const p = isObj(v) ? v : {};
  return {
    enabled: bool(p['enabled'], enabledByDefault),
    model: textOrNull(p['model'], false),
    effort: textOrNull(p['effort']),
    // 'shortName': this field's first stored key.
    displayName: normalizeDisplayName(p['displayName'] ?? p['shortName']),
  };
}

/**
 * Stored AI settings, losslessly: every stored provider entry and Jev switch survive a build without their plugin.
 * `declared` (the build's providers, in order) fills unset providers; `features` (the build's plugin switches) fills
 * unset switches with their defaults. Each feature picks its own provider (no default here).
 */
export function normalizeAiSettings(v: unknown, declared: readonly ProviderDefaults[] = [], features: readonly JevFeatureDefaults[] = []): AiSettings {
  const src = isObj(v) ? v : {};
  const stored = isObj(src['providers']) ? src['providers'] : {};
  const providers: Record<ProviderId, ProviderSettings> = {};
  for (const [id, p] of Object.entries(stored)) if (PROVIDER_ID.test(id) && isObj(p)) providers[id] = providerSettings(p, false);
  for (const d of declared) providers[d.id] = providerSettings(stored[d.id], d.enabledByDefault);
  const out: AiSettings = {
    providers,
    jevConnection: oneOf(JEV_CONNECTIONS, src['jevConnection'], DEFAULT_AI_SETTINGS.jevConnection),
    jev: { ...DEFAULT_AI_SETTINGS.jev },
  };
  const jev = isObj(src['jev']) ? src['jev'] : {};
  const kept = out.jev as Record<string, boolean>;
  for (const [f, on] of Object.entries(jev)) if (typeof on === 'boolean' && JEV_FEATURE_KEY.test(f) && !Object.hasOwn(RETIRED_JEV_FEATURES, f)) kept[f] = on;
  for (const f of HOST_JEV_FEATURES) out.jev[f] = bool(jev[f], false);
  for (const d of features) out.jev[d.key] = bool(jev[d.key], d.default);
  for (const [retired, f] of Object.entries(RETIRED_JEV_FEATURES)) out.jev[f] ||= bool(jev[retired], false);
  return out;
}
