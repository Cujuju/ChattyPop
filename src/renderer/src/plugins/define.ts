// A bundled plugin's renderer side (docs/plugin-architecture.md §2–§3): views and reactive functions for its declared
// panels, settings pages and rule actions, and its items in host slots. A leaf module, like ./bundledTypes.
import type { MessageMenuView, PersonLinksView, PersonSectionView, ReadContributions } from './readSlots';
import type { FrameContributions, NotificationKindView, PhoneDrawerView, PhoneSectionView, ProviderRowView, StatusBarView, TopBarView } from './frameSlots';
import type { AttachmentBarView, ChatFooterView, HoverBarView, MessageContributions } from './messageSlots';
import type { JevFeatureView } from '../views/settings/jevFeatures';
import type { ManagedRuleControl } from '../state/managedControls';
import type { Component, JSX } from 'solid-js';
import type { ChannelsOf, JevFeatures, NoticeKinds, PanelIds, PluginDescriptor, ProviderIds, RuleTypes, RuleConfig, SettingsIds, ShortcutKeys, SlotIds } from '@shared/bundledTypes';
import type { SlotKind } from '@shared/slots';
import type { MembersFor } from '@shared/pluginChannels';
import type { ModelOption, ProviderStatus } from '@shared/contract';
import type { RuleSection } from '@shared/ruleKinds/types';
import type { Rule } from '@shared/rules';
import type { KindView, FilterView } from '@/views/settings/rules/kinds/types';
import type { ComposerCommand, RuleTemplate, UnreadSource } from './bundledTypes';

/** A declared panel's view, and what it has that the user hasn't seen. */
export interface PanelView {
  view: Component;
  unread?: UnreadSource;
}

/** A declared settings page's view: a tab's page, or a section on a host page. */
export interface SettingsView {
  body: () => JSX.Element;
  /** One line under the section's label: its current state. Sections only. */
  meta?: () => string;
  /** Dims the section's entry (a feature that's off). Sections only. */
  muted?: () => boolean;
}

/** A declared AI provider's own part of its Settings → AI section; the host draws the rest. */
export interface ProviderView {
  /** Its own rows, at the end of its card (an address). */
  rows?: Component;
  /** Appended to its availability line (a cost note); none when undefined. */
  note?(status: ProviderStatus): string | undefined;
  /** Beside each listed model's Use choice (Ollama's Delete). */
  modelAction?: Component<{ model: ModelOption }>;
}

/** What each declaration needs, required exactly when the descriptor declares one. */
type Views<K extends string, Field extends string, V> = [K] extends [never] ? { [F in Field]?: never } : { [F in Field]: { [Id in K]: V } };

/** The host's slots a plugin's renderer side may add to without declaring (docs/plugin-architecture.md §3). */
export interface SlotContributions extends Omit<ReadContributions & FrameContributions & MessageContributions, SlotKind | 'notificationKinds'> {
  rules?: RuleSlots;
  composer?: {
    /** Lines of the composer's `/` menu for commands ChattyPop answers. */
    commands(): ComposerCommand[];
  };
}

/** Rule slots independent of kind declarations; `F` names the plugin's Jev switches. */
export interface RuleSlots<F extends string = string> {
  managedControls?: Readonly<Record<string, ManagedRuleControl<F>>>;
  activity?(rule: Rule): string | null;
  actsAsYouNote?: Component;
  ruleBadge?(rule: Rule): JSX.Element | null;
}

type SectionViews<D, S extends RuleSection> = {
  [T in RuleTypes<D, S>]: S extends 'filters' ? FilterView<RuleConfig<D, S, T>> : KindView<RuleConfig<D, S, T>>;
};
type DeclaredViews<D> = {
  [S in RuleSection as [RuleTypes<D, S>] extends [never] ? never : S]: SectionViews<D, S>;
};
type RuleViews<D> = [RuleTypes<D, 'triggers'> | RuleTypes<D, 'match'> | RuleTypes<D, 'filters'> | RuleTypes<D, 'actions'>] extends [never]
  ? { rules?: RuleSlots<JevFeatures<D>> & DeclaredViews<D> }
  : { rules: RuleSlots<JevFeatures<D>> & DeclaredViews<D> };

/** The plugin's core calls windows may make; menu actions name theirs, so a window that can't make them never offers them. */
type WindowCalls<D> = { calls: readonly (keyof MembersFor<ChannelsOf<D>, 'core', 'renderer' | 'phone'> & string)[] };
type MenuSlots<D> = {
  channels?: NonNullable<ReadContributions['channels']> & WindowCalls<D>;
};

/** Each host slot's view type. */
type SlotViewTypes<D> = {
  topBar: TopBarView;
  statusBar: StatusBarView;
  phoneSections: PhoneSectionView;
  phoneDrawer: PhoneDrawerView;
  providerRows: ProviderRowView;
  messageMenu: MessageMenuView & WindowCalls<D>;
  chatFooter: ChatFooterView;
  hoverEmoji: HoverBarView;
  hoverActions: HoverBarView;
  attachmentActions: AttachmentBarView;
  ruleTemplates: RuleTemplate;
  personSections: PersonSectionView;
  personLinks: PersonLinksView;
};
/** Slots the descriptor declares items in, and those it doesn't. */
type DeclaredSlots<D> = { [K in SlotKind]: [SlotIds<D, K>] extends [never] ? never : K }[SlotKind];
/**
 * A view for exactly each item the descriptor declares in a host slot, by local id; no views for undeclared slots.
 * One mapped type, not an intersection per slot: that many intersections exceed the compiler's union limit (TS2590).
 */
type SlotViews<D> = { [K in DeclaredSlots<D>]: { [Id in SlotIds<D, K>]: SlotViewTypes<D>[K] } } & {
  [K in Exclude<SlotKind, DeclaredSlots<D>>]?: never;
};

/** Views required by the descriptor and optional slot contributions. */
export type RendererContributions<D extends PluginDescriptor> = Views<PanelIds<D>, 'panels', PanelView> &
  Views<SettingsIds<D>, 'settings', SettingsView> &
  RuleViews<D> &
  Views<ShortcutKeys<D>, 'shortcuts', () => void> &
  Views<JevFeatures<D>, 'jevFeatures', JevFeatureView> &
  Views<NoticeKinds<D>, 'notificationKinds', NotificationKindView> &
  { providers?: { [Id in ProviderIds<D>]?: ProviderView } } &
  MenuSlots<D> &
  SlotViews<D> &
  SlotContributions;

/** A plugin's renderer side as the registry holds it. */
export interface RendererPlugin<D extends PluginDescriptor = PluginDescriptor> {
  plugin: D;
  contributions: RendererContributions<D>;
}

/** Contributions as the registry reads them: by id, whatever the descriptor declared. */
export type LooseContributions = {
  panels?: Readonly<Record<string, PanelView>>;
  settings?: Readonly<Record<string, SettingsView>>;
  rules?: RuleSlots & { [S in RuleSection]?: Readonly<Record<string, S extends 'filters' ? FilterView : KindView>> };
  shortcuts?: Readonly<Record<string, () => void>>;
  providers?: Readonly<Record<string, ProviderView>>;
  jevFeatures?: Readonly<Record<string, JevFeatureView>>;
} & SlotContributions & ReadContributions & FrameContributions & MessageContributions & { ruleTemplates?: Readonly<Record<string, RuleTemplate>> };
