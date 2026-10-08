// Joins installed renderer contributions with descriptors for active slots. Views access entries without importing plugin source or registry.
import type { Component } from 'solid-js';
import { placeByAnchor } from '@shared/anchors';
import { bundledPanels, bundledShortcuts, noticeAnchor, settingsTabAnchor, shortcutAnchor, slotAnchor } from '@shared/bundledPlugins';
import type { SettingsDecl } from '@shared/bundledTypes';
import { rendererPlugins } from './installed';
import { groupShortcutHints } from './shortcutHints';
import { readSlots } from './readSlots';
import { jevFeatureSlots } from './jevSlots';
import { frameSlots, HOST_NOTIFICATION_KINDS } from './frameSlots';
import { messageSlots } from './messageSlots';
import { unreadCounts } from '../state/unreadCounts';
import { bindManagedControls } from '../state/managedControls';
import { ruleSlots } from './ruleSlots';
import { declaredItems, placeSlot, type SlotItem } from './slotItems';
import { pluginActive, pluginMayCall } from '@/state/plugins';
import type { ComposerCommand, MessageMenuScope, RuleTemplate, SettingsPageId, SettingsTab, UnreadSource } from './bundledTypes';
import type { LooseContributions, PluginWindowView, ProviderView, RendererPlugin, SettingsView } from './define';
import type { SettingsSectionDef } from '@/views/settings/SettingsLayout';

export type { ComposerCommand, MessageMenuScope, RuleTemplate, SettingsPageId, SettingsTab, UnreadSource } from './bundledTypes';
const contributions = (p: RendererPlugin): LooseContributions => p.contributions as LooseContributions;
/** Plugins that are on. Reactive: call inside a tracking scope. */
const active = (): RendererPlugin[] => rendererPlugins().filter((p) => pluginActive(p.plugin.manifest.id));
/** Each settings page a plugin that is on declares, with its view. Reactive. */
const settingsPages = (): { decl: SettingsDecl; view: SettingsView }[] =>
  active().flatMap((p) =>
    (p.plugin.settings ?? []).flatMap((decl) => {
      const view = contributions(p).settings?.[decl.id];
      return view ? [{ decl, view }] : [];
    }),
  );

const ruleViews = ruleSlots(
  () => rendererPlugins().map((entry) => ({ plugin: entry.plugin, contributions: contributions(entry) })),
  pluginActive,
);
/** A kind editor and summary, including those belonging to disabled plugins. */
export const pluginKindView = ruleViews.view;
/** Whether a kind can be added now; existing parts retain their editors. */
export const kindOffered = ruleViews.offered;
/** Active plugin badges for one rule row. */
export const ruleBadges = ruleViews.badges;
export const ruleActivity = ruleViews.activity;
export const managedRuleFeatures = ruleViews.features;
bindManagedControls(ruleViews.control);
/** Feature wording from active plugins, alongside the host's settings rows. */
export const pluginJevFeatures = () => jevFeatureSlots(rendererPlugins().map((p) => ({ plugin: p.plugin, contributions: contributions(p) })), pluginActive);

/** host templates with active plugins' templates (stamped ids) placed among them. Reactive. */
export const withPluginTemplates = <T extends { id: string }>(host: readonly T[], make: (t: SlotItem<RuleTemplate>) => T): T[] =>
  placeSlot('ruleTemplates', host, declaredItems(active(), 'ruleTemplates', (p) => contributions(p).ruleTemplates).map(make), slotAnchor);
/** Active plugins’ notes under the Discord-posting permission. */
export const actsAsYouNotes = (): Component[] => active().flatMap((p) => contributions(p).rules?.actsAsYouNote ?? []);
/** Composer commands contributed by active plugins. */
export const composerCommands = (): ComposerCommand[] => active().flatMap((p) => contributions(p).composer?.commands() ?? []);

/** Provider `id`'s own Settings → AI rows and note, while its plugin is on. Reactive. */
export const providerView = (id: string): ProviderView | undefined => active().flatMap((p) => contributions(p).providers?.[id] ?? [])[0];

/** Plugins' sections on a host settings page. Reactive. */
export const settingsSections = (page: SettingsPageId): SettingsSectionDef[] =>
  settingsPages().flatMap(({ decl, view }) =>
    decl.page === page ? [{ id: decl.id, label: decl.label, body: view.body, ...(view.meta && { meta: view.meta }), ...(view.muted && { muted: view.muted }) }] : [],
  );

const tabCache = new Map<string, SettingsTab>();

/** `host` tabs with the tabs of plugins that are on, each placed after its anchor. Reactive. */
export function withPluginTabs<T extends SettingsTab>(host: readonly T[]): (T | SettingsTab)[] {
  const tabs = settingsPages().flatMap(({ decl, view }): SettingsTab[] =>
    !decl.tab ? [] : [(() => {
      let tab = tabCache.get(decl.id);
      if (!tab) {
        tab = { id: decl.id, label: decl.label, ...(decl.tab.groupStart && { groupStart: true as const }), icon: () => <path d={decl.tab!.iconPath} />, body: view.body };
        tabCache.set(decl.id, tab);
      }
      return tab;
    })()],
  );
  return placeByAnchor<T | SettingsTab>(host, tabs, (t) => t.id, settingsTabAnchor);
}

/** A status-bar shortcut hint: the keys and what they do. */
export interface ShortcutHint {
  id: string;
  keys: string;
  hint: string;
  hintGroup?: string;
}

/** The action plugin `pluginId` declares under `key`, while it is on, or null. */
export const shortcutAction = (pluginId: string, key: string): (() => void) | null =>
  active().flatMap((p) => (p.plugin.manifest.id === pluginId ? (contributions(p).shortcuts?.[key] ?? []) : []))[0] ?? null;
/** The host's hints with each shortcut of a plugin that is on after its anchor, labelled with its bound key. Reactive. */
export function withPluginShortcuts(host: readonly ShortcutHint[], keysOf: (pluginId: string, key: string) => string): ShortcutHint[] {
  const on = bundledShortcuts().filter((s) => pluginActive(s.pluginId));
  const hints = on.map((s) => ({ id: s.key, keys: keysOf(s.pluginId, s.key), hint: s.hint, hintGroup: s.hintGroup }));
  const placed = placeByAnchor<ShortcutHint>(host, hints, (h) => h.id, shortcutAnchor);
  return groupShortcutHints(placed);
}

/** Bundled panels whose plugin is on. Reactive. */
export const activeBundledPanels = () => bundledPanels().filter((p) => pluginActive(p.pluginId));

/** A bundled panel's component while its plugin is on; null otherwise (the layout shows its missing-panel note). */
export const panelComponent = (id: string): Component | null => active().flatMap((p) => contributions(p).panels?.[id]?.view ?? [])[0] ?? null;

/** Plugin `pluginId`'s window kind `window` while the plugin is on, or undefined. Reactive. */
export const pluginWindowView = (pluginId: string, window: string): PluginWindowView | undefined =>
  active().flatMap((p) => (p.plugin.manifest.id === pluginId ? (contributions(p).windows?.[window] ?? []) : []))[0];

/** Panel `id`'s unseen-items source from a plugin that is on, or undefined. Reactive. */
export const bundledUnread = (id: string): UnreadSource | undefined => active().flatMap((p) => contributions(p).panels?.[id]?.unread ?? [])[0];

const reads = readSlots(() => rendererPlugins().map((p) => ({ plugin: p.plugin, contributions: contributions(p) })), pluginActive, pluginMayCall, slotAnchor);
/** Active message menu groups, preserving each plugin's optional heading. */
export const messageMenuGroups = reads.messages;
/** Active sections rendered after a person's channels. */
export const personSections = reads.people;
/** The active view of a person's links, or null: the Person window then lists them plainly. */
export const personLinks = reads.personLinks;
/** Active Jev actions for a channel the host permits Jev to read. */
export const channelJevContributions = reads.channels;
/** Active parser token declarations and search hints. */
export const searchTokens = reads.search;

const messages = messageSlots(() => rendererPlugins().map((p) => ({ plugin: p.plugin, contributions: contributions(p) })), pluginActive, slotAnchor);
/** Host and active plugin items under the Archive view's log, through shared placement. */
export const chatFooterItems = messages.chatFooter;
/** Host and active plugin reaction groups in a hovered message's bar, through shared placement. */
export const hoverEmojiItems = messages.hoverEmoji;
/** Host and active plugin actions in a hovered message's bar, before More, through shared placement. */
export const hoverActionItems = messages.hoverActions;
/** Host and active plugin actions in a hovered attachment's bar, through shared placement. */
export const attachmentActionItems = messages.attachmentActions;

const frame = frameSlots(() => rendererPlugins().map((p) => ({ plugin: p.plugin, contributions: contributions(p) })), pluginActive, slotAnchor, noticeAnchor);
/** Host and active plugin top-bar items through shared placement. */
export const topBarItems = frame.topBar;
/** Host and active plugin status-bar items through shared placement. */
export const statusBarItems = frame.statusBar;
/** Host and active plugin companion sections through shared placement. */
export const phoneSections = frame.phone;
/** Host and active plugin companion drawer panes through shared placement. */
export const phoneDrawerItems = frame.phoneDrawer;
/** Host and active plugin rows of a provider's card in Settings → AI, through shared placement. */
export const providerRows = frame.providerRows;
/** Host and active plugin notice kinds through shared placement. */
export const notificationKinds = () => frame.notificationKinds(HOST_NOTIFICATION_KINDS);
unreadCounts.plugins(frame.unread);
