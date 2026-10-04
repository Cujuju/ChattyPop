// Bundled plugins' descriptor contract (docs/plugin-architecture.md §2): what a plugin's shared entry declares. Plugins build it with @plugin-sdk/shared; the registry over them is ./bundledPlugins (importing that from here would be a cycle). Its build-time checks are ./bundledCheck.
import type { ArchiveRef } from './archiveRefs';
import type { SearchToken } from './searchTokens';
import type { JevQueryDef } from './jevQueries';
import { isHostJevFeature, type HostJevFeature, type JevFeature } from './aiSettings';
import type { OwnerUrl, ProviderDecl } from './descriptorParts';
import type { Placement, SettingsPageId } from './anchors';
import type { AnyChannels } from './pluginChannels';
import type { RuleAction, RuleSpec } from './rules';
import type { RuleSections, RuleSection } from './ruleKinds/types';
import type { AnyPreference, PreferenceField, PreferenceNames } from './preferences';
import type { SlotDecls, SlotKind } from './slots';

/** Bundled plugin identity and display metadata. */
export interface BundledManifest {
  id: string;
  name: string;
  version: string;
  description: string;
}

/** A bundled plugin action declaration; its type and configuration are stored unchanged in v4 rules. */
export type { RuleActionKind as RuleActionType } from './ruleKinds/types';

/** How much a panel stands out; each theme decides how (renderer panels/titles.ts). */
export type PanelImportance = 'primary' | 'secondary' | 'reference';

/** A panel's place: after or before a host panel (HOST_PANELS) or another plugin's. */
export type PanelAnchor = { after: string; before?: never } | { before: string; after?: never };

/** A panel a plugin adds; its view is in the renderer side under the same id. Its anchor orders the top bar and menus. */
export type PanelDecl = PanelFields & PanelAnchor;

interface PanelFields {
  /** Placement in default layouts, before unavailable panels are pruned. */
  presets?: readonly ({ id: string; size?: number | 'auto' } & PanelAnchor)[];
  /** A layout panel id, unique across the build; the theme keys section colour on it (data-section). */
  id: string;
  title: string;
  importance: PanelImportance;
  /** The top bar opens it in an in-app window, like Settings (renderer state/ui.ts DIALOG_PANELS). */
  dialog: boolean;
  /** SVG path data for its header and top-bar icon, drawn like SectionIcon's. */
  iconPath: string;
}

/** A single-key shortcut a plugin adds; its action is in the renderer side under the same key. */
export interface ShortcutDecl {
  /** Adjacent hints in this group share one label and combine their keys. */
  hintGroup?: string;
  /** One lowercase letter no host shortcut takes (HOST_SHORTCUTS). */
  key: string;
  /** The status bar's hint for it. */
  hint: string;
  /** What this one key does, for Settings; defaults to the hint. Keys sharing a grouped hint each take one ("next source"). */
  name?: string;
  /** The hint it follows: a host shortcut (HOST_SHORTCUTS) or another plugin's key. */
  after: string;
}

/** A settings page a plugin adds: its own tab, or a section on a host page. Its body is in the renderer side. */
export type SettingsDecl = { id: string; label: string } & (
  { tab: { after: string; iconPath: string; groupStart?: true }; page?: never } | { page: SettingsPageId; tab?: never }
);

/**
 * Data from before the feature was a plugin, renamed into its namespace at startup whether or not it is on: host tables
 * (old name → its table name), settings keys (old key → its preference), built-in rule keys (old key → its managed
 * rule key) and a profile folder (→ its data folder).
 */
export interface Adoption {
  /** Legacy action-run kinds mapped to this plugin's declared action types. */
  actionKinds?: Readonly<Record<string, string>>;
  /**
   * Move individual JSON fields into the same field of an owned preference, retaining existing destination values.
   * `shared`: copy without removing the source, so every plugin adopting that field gets it.
   */
  settingFields?: readonly { key: string; field: string; name: string; shared?: boolean }[];
  tables?: Readonly<Record<string, string>>;
  settings?: Readonly<Record<string, string>>;
  /** Legacy managed-rule keys mapped to local keys, preserving rule ids and references. */
  managedRules?: Readonly<Record<string, string>>;
  /** Stored Jev switch keys from before the switch was this plugin's, mapped to its declared keys. */
  jevFeatures?: Readonly<Record<string, string>>;
  /** Notice kinds phones chose before the kind was this plugin's, mapped to its declared kinds. */
  noticeKinds?: Readonly<Record<string, string>>;
  /** Section ids a phone may have stored (its last section, a notice's target) mapped to local ids; resolved when read. */
  phoneSections?: Readonly<Record<string, string>>;
  dataDir?: string;
}

/** A Settings → Jev switch a plugin declares; stored and asked for as `<plugin id>.<key>`. */
/**
 * A Settings → Jev switch; its row goes after or before a host switch or one of the plugin's own (stamped
 * `<id>.<key>`) within its group, else after the group's rows.
 */
export type JevFeatureDecl = {
  /** An identifier no host switch uses; never changes, since the owner's choice is stored under it. */
  key: string;
  /** The switch's name wherever the host lists it; its key when omitted. */
  label?: string;
  /** On in a profile that never set it. */
  default: boolean;
} & Placement;

/** A kind of notice a plugin sends (main ctx.notifications.show `kind`); phones choose kinds by `<plugin id>.<kind>`. */
export type NoticeDecl = {
  kind: string;
  /** Core chose or redacted it under privacy mode: one made before privacy mode changed is not sent. */
  privacyScoped?: true;
} & Placement; // among the phone's choices and Settings → Notifications: after or before a host kind or a stamped one

/**
 * A plugin's Jev query; Settings → Jev → Queries lists it within its group after or before a query id there (the
 * host's or a plugin's), else after the group's host queries.
 */
export type JevQueryDecl<F extends string = string> = JevQueryDef<F> & Placement;

/** A plugin's shared entry (its folder's shared/index.ts): component-free, so any process and module may import it. */
export interface PluginDescriptor {
  manifest: BundledManifest;
  /** Singular coverage noun and its past participle; one owner per build. */
  coverage?: {
    noun: string;
    past: string;
  };
  /** Names for AI work; one owner per build. */
  aiRuns?: {
    singular: string;
    plural: string;
    active: string;
  };
  /** Plural noun for this plugin’s encrypted stored content. */
  storedContent?: string;
  /** Its stored values (definePreference), by name; every process reads and writes them typed. */
  preferences?: Readonly<Record<string, AnyPreference>>;
  /** AI providers its core side registers, in the order Settings → AI lists them. */
  providers?: readonly ProviderDecl[];
  channels?: AnyChannels;
  panels?: readonly PanelDecl[];
  settings?: readonly SettingsDecl[];
  rules?: { [S in RuleSection]?: readonly RuleSections[S][] };
  /** Validates stored managed rules by local key, including adopted identities. */
  managedRules?: Readonly<Record<string, (spec: RuleSpec) => void>>;
  jev?: {
    /**
     * Its Jev queries (Settings → Jev → Queries), listed by group and placement. The owner's edits are stored by query
     * id, so an id never changes, even one that predates the plugin.
     */
    queries?: readonly JevQueryDecl<string>[];
    /** Its Settings → Jev switches; shown while it is on, their stored values kept while it is off or absent. */
    features?: readonly JevFeatureDecl[];
  };
  /** The kinds of notice it sends; phones choose which to be sent (stored as `<plugin id>.<kind>`). */
  notices?: readonly NoticeDecl[];
  search?: {
    tokens?: readonly SearchToken[];
    /** Its core side registers a search ranker (ctx.search.rerank), which reorders full-text hits. */
    ranker?: true;
  };
  adopts?: Adoption;
  /** Host-owned visibility views for archive references in local plugin tables. */
  archiveRefs?: Readonly<Record<string, ArchiveRef>>;
  shortcuts?: readonly ShortcutDecl[];
  /** Its items in host slots (top bar, status bar, phone, menus, templates), stamped `<plugin id>.<local id>` by the host. */
  slots?: SlotDecls;
  /** Where its core and main sides may fetch (ctx.net.fetch); never Discord, which only the embedded session reaches. */
  network?: {
    /** Hosts reached over HTTPS, with their subdomains. */
    hosts?: readonly string[];
    /** Addresses the owner types into its settings (a server on this PC or LAN): their origins, over HTTP too. */
    ownerUrls?: readonly OwnerUrl[];
    /** Its main side listens on a loopback port (main ctx.net.listen). */
    loopback?: true;
    /** Its main side publishes a loopback server on this PC's tailnet at this HTTPS port (main ctx.net.tailnet). */
    tailnet?: { httpsPort: number };
  };
  /** Its main side writes to Discord (posts, edits, reactions) as the owner: ctx.discord gets its write methods. */
  discord?: { write?: true };
  /** Host features it turns on while it is on: `posting`, the host's own posting calls (shared/posting.ts). */
  unlocks?: { posting?: true };
  /**
   * The phone: `transport` carries it (at most one per build, main ctx.phone.connect); `routes` its main side serves
   * there. What of its preferences the phone reads is each preference's `phone`.
   */
  phone?: {
    transport?: true;
    routes?: readonly string[];
  };
}

/**
 * Where a descriptor names its own declarations, checked against them (definePlugin): owner addresses and adopted keys
 * and fields name declared preferences and fields their values have; its Jev queries name its switches or the host's;
 * adopted switches and notice kinds land on declared ones.
 */
export interface DescriptorRefs<D> {
  jev?: { queries?: readonly { features: readonly JevFeatureRef<D>[] }[] };
  network?: {
    ownerUrls?: readonly { [N in PreferenceNames<D>]: OwnerUrl & { setting: N; field: PreferenceField<D, N> } }[PreferenceNames<D>][];
  };
  adopts?: {
    settings?: Readonly<Record<string, PreferenceNames<D>>>;
    settingFields?: readonly { [N in PreferenceNames<D>]: { key: string; field: PreferenceField<D, N>; name: N; shared?: boolean } }[PreferenceNames<D>][];
    jevFeatures?: Readonly<Record<string, JevFeatures<D>>>;
    noticeKinds?: Readonly<Record<string, NoticeKinds<D>>>;
  };
}

type Ids<L, K extends string> = L extends readonly (infer E)[]
  ? E extends Record<K, infer I extends string>
    ? I
    : never
  : never;
/** Panel ids a descriptor declares. */
export type PanelIds<D> = D extends { panels: infer L } ? Ids<L, 'id'> : never;
/** Settings page ids a descriptor declares. */
export type SettingsIds<D> = D extends { settings: infer L } ? Ids<L, 'id'> : never;
/** Rule action types a descriptor declares. */
export type RuleActionTypes<D> = RuleTypes<D, 'actions'>;
/** Trigger types a descriptor declares. */
export type RuleTriggerTypes<D> = RuleTypes<D, 'triggers'>;
/** Match types a descriptor declares. */
export type RuleMatchTypes<D> = RuleTypes<D, 'match'>;
/** Filter types a descriptor declares. */
export type RuleFilterTypes<D> = RuleTypes<D, 'filters'>;
/** Kind names in one descriptor section. */
export type RuleTypes<D, S extends RuleSection> = D extends { rules: { [K in S]: infer L } } ? Ids<L, 'type'> : never;
/** Configuration belonging to a declared kind. */
export type RuleConfig<D, S extends RuleSection, T extends string> =
  D extends { rules: { [K in S]: readonly (infer E)[] } }
    ? Extract<E, { type: T }> extends { create(): infer C } ? C : never
    : never;
/** AI provider ids a descriptor declares. */
export type ProviderIds<D> = D extends { providers: infer L } ? Ids<L, 'id'> : never;
/** Local ids of the items a descriptor declares in host slot `K`. */
export type SlotIds<D, K extends SlotKind> = D extends { slots: { [P in K]: infer L } } ? Ids<L, 'id'> : never;
/** Shortcut keys a descriptor declares. */
export type ShortcutKeys<D> = D extends { shortcuts: infer L } ? Ids<L, 'key'> : never;
/** Settings → Jev switch keys a descriptor declares (unstamped). */
export type JevFeatures<D> = D extends { jev: { features: infer L } } ? Ids<L, 'key'> : never;
/** A switch a plugin names in its own code: one it declares, or the host's. */
export type JevFeatureRef<D> = JevFeatures<D> | HostJevFeature;
/** Notice kinds a descriptor declares (unstamped). */
export type NoticeKinds<D> = D extends { notices: infer L } ? Ids<L, 'kind'> : never;
/** Phone route names a descriptor declares. */
export type PhoneRouteNames<D> = D extends { phone: { routes: readonly (infer R extends string)[] } } ? R : never;
/** A descriptor's channel contract, or none. */
export type ChannelsOf<D> = D extends { channels: infer C } ? C : never;

/** A plugin table's name: p_<plugin id>_<name>. */
export const TABLE_NAME = /^[a-z0-9_]{1,40}$/;
/** The namespace every table of `pluginId` starts with. */
export const pluginTablePrefix = (pluginId: string): string => `p_${pluginId.replaceAll('-', '_')}_`;
/** Validates a local table name and prefixes it with the plugin namespace. */
export function pluginTableName(pluginId: string, name: string): string {
  if (!TABLE_NAME.test(name)) throw new Error(`Table name must match ${TABLE_NAME}: ${name}`);
  return `${pluginTablePrefix(pluginId)}${name}`;
}

/** Discord's domains: plugins never reach them (law 4: only the embedded client's session does). */
const DISCORD_HOST = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg|discord\.media)$/i;
/** A hostname as DNS resolves it: lowercase, without the root label's trailing dot (`discord.com.` is `discord.com`). */
export const canonicalHost = (hostname: string): string => hostname.toLowerCase().replace(/\.+$/, '');
/** Whether `hostname`, in any spelling, is one of Discord's, which plugins never fetch (law 4). */
export const isDiscordHost = (hostname: string): boolean => DISCORD_HOST.test(canonicalHost(hostname));
/** How much of a setting the phone reads: all of it, or these fields (dot paths into it); the rest reads as unset. */
export type PhoneSettingView = true | readonly string[];

/** A plugin setting's stored key: plugin.<plugin id>.<name>. */
export const pluginSettingKey = (pluginId: string, name: string): string => `plugin.${pluginId}.${name}`;

/** A new action of one of `plugin`'s own kinds with its default config. Reads the descriptor, not the registry, so no import cycle. */
export function newPluginAction<D extends PluginDescriptor>(plugin: D, type: RuleActionTypes<D>): RuleAction {
  const kind = plugin.rules?.actions?.find((k) => k.type === type);
  if (!kind) throw new Error(`${plugin.manifest.id} declares no rule action ${type}.`);
  return { id: crypto.randomUUID(), type, config: kind.create() };
}

/** A name a plugin declares, as stored and routed: `<plugin id>.<local>` (Jev switches, notice kinds). */
export const stampedName = (pluginId: string, local: string): `${string}.${string}` => `${pluginId}.${local}`;

/** The switch plugin `p` means by `ref`: the host's as named, its own stamped. Throws on one it doesn't declare. */
export function pluginJevFeature(p: PluginDescriptor, ref: string): JevFeature {
  if (isHostJevFeature(ref)) return ref;
  if (!p.jev?.features?.some((f) => f.key === ref)) throw new Error(`${p.manifest.id} names Jev switch ${ref} but declares none`);
  return stampedName(p.manifest.id, ref);
}

/** A plugin's managed-rule key as stored in `rules.builtin`. */
export const managedRuleKey = (pluginId: string, local: string): string => `${pluginId}.${local}`;

/** The plugin-local key of a stored managed-rule key; null when another owner's or none. */
export const localManagedKey = (pluginId: string, stored: string | null): string | null => {
  const prefix = managedRuleKey(pluginId, '');
  return stored?.startsWith(prefix) ? stored.slice(prefix.length) : null;
};
