// Descriptors every process reads: plugins (docs/plugin-architecture.md) from CHATTYPOP_PLUGIN_DIRS in development
// (chosen by CHATTYPOP_PLUGINS), then installed plugins main's start accepted (§16). Host code reaches plugin code only
// through virtual registries.
import build, { catalog } from 'virtual:bundled-plugins/shared';
import installed from 'virtual:installed-plugins/shared';
import { pluginJevFeature, pluginSettingKey, stampedName, type PanelDecl, type PluginDescriptor, type RuleActionType, type SettingsDecl, type ShortcutDecl } from './bundledTypes';
import { adoptedPhoneSections, catalogJevQueryAnchor, catalogNoticeAnchor, catalogSlotAnchor, checkBundled } from './bundledCheck';
import { mergedCatalog } from './installedCheck';
import { placementAnchor, type PlacementAnchor } from './anchors';
import type { SlotKind } from './slots';
import type { JevQueryDef } from './jevQueries';
import { adoptNoticeKinds, privacyScopedIn } from './notices';
import type { JevFeatureDefaults } from './aiSettings';
import { audiencesOf, type Audience, type ChannelShapes } from './pluginChannels';

const bundled: readonly PluginDescriptor[] = [...build, ...installed];
/** Every plugin folder's anchors (the build's catalog when it leaves plugins out, else its own), with installed plugins'. */
const ANCHORS = mergedCatalog(build, catalog, installed);
// Installed plugins come apart: an unstamped anchor on one not installed is no typo (UnknownAnchors).
checkBundled(bundled, ANCHORS, installed.length ? 'absent' : 'typo');
const PANEL_ANCHORS = new Map(Object.entries(ANCHORS.panels));
const TAB_ANCHORS = new Map(Object.entries(ANCHORS.tabs));
const SHORTCUT_ANCHORS = new Map(Object.entries(ANCHORS.shortcuts));

/** Descriptors included by this build, in build order, then the installed ones main's start accepted, in id order. */
export const BUNDLED_PLUGINS: readonly PluginDescriptor[] = bundled;
const BY_ID = new Map(bundled.map((p) => [p.manifest.id, p]));
/** Finds a bundled plugin descriptor by id. */
export const bundledPlugin = (id: string): PluginDescriptor | null => BUNDLED_PLUGINS.find((p) => p.manifest.id === id) ?? null;

const ACTION_TYPES = new Map(bundled.flatMap((p) => p.rules?.actions ?? []).map((t) => [t.type, t]));
const PANELS = new Map(bundled.flatMap((p) => (p.panels ?? []).map((panel) => [panel.id, { ...panel, pluginId: p.manifest.id }] as const)));
const SETTINGS = new Map(bundled.flatMap((p) => (p.settings ?? []).map((s) => [s.id, { ...s, pluginId: p.manifest.id }] as const)));
const SHORTCUTS = new Map(bundled.flatMap((p) => (p.shortcuts ?? []).map((s) => [s.key, { ...s, pluginId: p.manifest.id }] as const)));

/** The rule action type this build provides, or null (its plugin isn't in this build). */
export const ruleActionType = (type: string): RuleActionType | null => ACTION_TYPES.get(type) ?? null;
/** Action declarations contributed by bundled plugins. */
export const ruleActionTypes = (): RuleActionType[] => [...ACTION_TYPES.values()];
/** The plugin that provides a rule action type. */
export const actionTypePlugin = (type: string): string => type.slice(0, type.indexOf('.'));

/** A bundled panel by layout id, or null. */
export const bundledPanel = (id: string): (PanelDecl & { pluginId: string }) | null => PANELS.get(id) ?? null;
/** Where a plugin panel goes in the top bar and panel menus, whether its plugin is on, off or left out of this build. */
export const panelAnchor = (id: string): PlacementAnchor | undefined => PANEL_ANCHORS.get(id) ?? undefined;
/** Bundled panels with their owning plugin ids. */
export const bundledPanels = (): (PanelDecl & { pluginId: string })[] => [...PANELS.values()];
/** Bundled settings pages (tabs and sections), in build order. */
export const bundledSettings = (): (SettingsDecl & { pluginId: string })[] => [...SETTINGS.values()];
/** The anchor a plugin settings tab follows, whether its plugin is on, off or left out of this build. */
export const settingsTabAnchor = (id: string): string | undefined => TAB_ANCHORS.get(id) ?? undefined;

/** Bundled shortcuts, in build order. */
export const bundledShortcuts = (): (ShortcutDecl & { pluginId: string })[] => [...SHORTCUTS.values()];
/** The hint a plugin shortcut follows, whether its plugin is on, off or left out of this build. */
export const shortcutAnchor = (key: string): string | undefined => SHORTCUT_ANCHORS.get(key) ?? undefined;
/** Where a plugin's slot item (by stamped id) goes, whether its plugin is on, off or left out of this build; host items have none. */
export const slotAnchor: (kind: SlotKind, id: string) => PlacementAnchor | undefined = catalogSlotAnchor(ANCHORS);
/** A notice kind's declared anchor, from every plugin folder's catalog: a kind left out of this build keeps its place. */
export const noticeAnchor: (kind: string) => PlacementAnchor | undefined = catalogNoticeAnchor(ANCHORS);
/** A plugin Jev query's declared anchor, from every plugin folder's catalog: a query left out of this build keeps its place. */
export const jevQueryAnchor: (id: string) => PlacementAnchor | undefined = catalogJevQueryAnchor(ANCHORS);

const PHONE_SECTION_ALIASES = adoptedPhoneSections(bundled);
/** The stamped phone section an old section id (a phone's stored choice or notice target) was adopted as; undefined for none. */
export const adoptedPhoneSection = (old: string): string | undefined => PHONE_SECTION_ALIASES.get(old);

const QUERY_PLUGIN = new Map(bundled.flatMap((p) => (p.jev?.queries ?? []).map((q) => [q.id, p.manifest.id] as const)));

/** A plugin's Settings → Jev switch as the host lists it: its stamped key, name, default, owner and row placement. */
export interface BundledJevFeature extends JevFeatureDefaults {
  label: string;
  pluginId: string;
  anchor?: PlacementAnchor;
}
const FEATURES: readonly BundledJevFeature[] = bundled.flatMap((p) =>
  (p.jev?.features ?? []).map((f) => ({
    key: stampedName(p.manifest.id, f.key),
    label: f.label ?? f.key,
    default: f.default,
    pluginId: p.manifest.id,
    anchor: placementAnchor(f),
  })),
);

/** Who may reach a plugin's call or event (its channel contract); none when it declares no such member. */
export const channelAudiences = (pluginId: string, section: keyof ChannelShapes, name: string): readonly Audience[] =>
  audiencesOf(BY_ID.get(pluginId)?.channels, section, name);
/** Whether the phone may make this plugin core call. */
export const phoneMayCall = (pluginId: string, name: string): boolean => channelAudiences(pluginId, 'core', name).includes('phone');
/** Whether this plugin event reaches the phone. */
export const phoneGetsEvent = (pluginId: string, name: string): boolean => channelAudiences(pluginId, 'events', name).includes('phone');

const PREFERENCE_KEYS = new Set(bundled.flatMap((p) => Object.keys(p.preferences ?? {}).map((name) => pluginSettingKey(p.manifest.id, name))));
/** Whether `key` (plugin.<id>.<name>) is a preference a plugin in this build declares. */
export const isPluginPreference = (key: string): boolean => PREFERENCE_KEYS.has(key);

/** The Jev queries this build's plugins add, their switches stamped (the host's catalog merges them in). */
export const bundledJevQueries = (): JevQueryDef[] =>
  bundled.flatMap((p) => (p.jev?.queries ?? []).map((q) => ({ ...q, features: q.features.map((f) => pluginJevFeature(p, f)) })));
/** The bundled plugin a Jev query belongs to; null for the host's own. */
export const jevQueryPlugin = (id: string): string | null => QUERY_PLUGIN.get(id) ?? null;
/** This build's plugin switches, in build and declaration order. */
export const bundledJevFeatures = (): readonly BundledJevFeature[] => FEATURES;
/** The bundled plugin a Settings → Jev switch belongs to; null for the host's own. */

/** Whether notice kind `kind` is privacy-scoped (its declaration's `privacyScoped`). */
export const privacyScopedNotice = (kind: string): boolean => privacyScopedIn(bundled, kind);
/** A phone's stored notice choices, adopted by the installed plugins (adoptNoticeKinds). */
export const adoptedNoticeKinds = (kinds: readonly unknown[]): string[] => adoptNoticeKinds(bundled, kinds);
