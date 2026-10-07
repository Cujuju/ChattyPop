// Plugin SDK, shared part (docs/plugin-architecture.md): a plugin's descriptor, its channel contract, and the host vocabulary any process may use. Plugins import only @plugin-sdk/*, their own folder and packages.
import type { DescriptorRefs, PluginDescriptor } from '@shared/bundledTypes';
import type { PreferenceNames } from '@shared/preferences';
import type { RuleTriggerKind, RuleMatchKind, RuleFilterKind, RuleActionKind } from '@shared/ruleKinds/types';
import { pluginSettingKey, pluginTableName } from '@shared/bundledTypes';

export type * from '@shared/ruleKinds/types';
export { AFTER_MESSAGE } from '@shared/ruleKinds/types';
export type {
  RuleInput,
  RuleSpec,
  RulePart,
  Rule,
  RuleGates,
  RuleTrigger,
  RuleMatch,
  RuleNarrow,
  RuleAction,
  RuleOutcome,
  RuleRun,
} from '@shared/rules';

export type {
  Adoption,
  BundledManifest as Manifest,
  ChannelsOf,
  JevFeatureDecl,
  JevFeatureRef,
  JevQueryDecl,
  JevFeatures,
  NoticeDecl,
  NoticeKinds,
  PanelDecl,
  PanelIds,
  PanelImportance,
  PhoneRouteNames,
  PluginDescriptor,
  ProviderIds,
  RuleActionType,
  RuleActionTypes,
  RuleTriggerTypes,
  RuleMatchTypes,
  RuleFilterTypes,
  RuleTypes,
  RuleConfig,
  SettingsDecl,
  SettingsIds,
  ShortcutDecl,
  ShortcutKeys,
  SlotIds,
} from '@shared/bundledTypes';
export type { SlotDecl, SlotDecls, SlotKind } from '@shared/slots';
export type { Placement } from '@shared/anchors';
export type { OwnerUrl, ProviderDecl } from '@shared/descriptorParts';
export { definePreference, type CorePreferences, type FieldPath, type MainPreferences, type PhoneView, type Preference, type PreferenceField, type PreferenceNames, type PreferenceValue } from '@shared/preferences';
export { newPluginAction } from '@shared/bundledTypes';
export type { RuleTemplate } from '@shared/ruleTemplates';
export type { Audience, CallMember, ChannelShapes, Channels, Client, Decoder, EventsOf, MembersFor, Served } from '@shared/pluginChannels';
// The phone transport's codec and the shapes it carries.
export { decodeWire, encodeWire, type IsWire, type Wire, type WireValue } from '@shared/wire';
export { defineChannels } from '@shared/pluginChannels';
export type { HostPanelId, HostRuleTemplateId, HostSettingsTabId, HostShortcutId, SettingsPageId } from '@shared/anchors';

/** Preserves literal descriptor ids for exact side implementation types. Referenced preferences, fields, switches and notice kinds must be declared. */
export const definePlugin = <const D extends PluginDescriptor>(d: D & DescriptorRefs<D>): D => d;

/** Declares a typed rule trigger kind. */
export const defineRuleTrigger = <const K extends RuleTriggerKind>(
  kind: K & { validate(config: ReturnType<K['create']>): void },
): K => kind;

/** Declares a typed rule match kind. */
export const defineRuleMatch = <const K extends RuleMatchKind>(
  kind: K & { validate(config: ReturnType<K['create']>): void },
): K => kind;

/** Declares a typed rule filter kind. */
export const defineRuleFilter = <const K extends RuleFilterKind>(
  kind: K & { validate(config: ReturnType<K['create']>): void },
): K => kind;

/** Declares a typed rule action kind. */
export const defineRuleAction = <const K extends RuleActionKind>(
  kind: K & { validate(config: ReturnType<K['create']>): void },
): K => kind;

/** A plugin table's name, for constants in its SQL (the core side's storage.table gives the same). */
export const pluginTable = (plugin: PluginDescriptor, name: string): string => pluginTableName(plugin.manifest.id, name);
/** A plugin preference's stored key, as setting-changed events name it. */
export const pluginSetting = <D extends PluginDescriptor>(plugin: D, name: PreferenceNames<D>): string => pluginSettingKey(plugin.manifest.id, name);

// Host vocabulary.
export * from '@shared/units';
export * from '@shared/errors';
export * from '@shared/normalize';
export { cutText } from '@shared/text';
export * from '@shared/async';
export * from '@shared/discord';
export * from '@shared/emoji';
export { attachmentFileName, embedShowsPictures, embedVideoHasSound, mediaKind } from '@shared/media';
export * from '@shared/links';
export { PROVIDER_DISPLAY_NAME_MAX, normalizeDisplayName, normalizeProviderId, type AiSettings, type ProviderId, type ProviderSettings } from '@shared/settings';
export { andList, orList } from '@shared/lists';
export type { JevQueryDef } from '@shared/jevQueries';
export { MESSAGE_SEES } from '@shared/jevQueries/messages';
export type { ArchiveAttachment, ArchiveEmbed, ArchiveEmoji, ArchiveMessage, AttachmentNote, ModelOption, SearchHit } from '@shared/contract';

export { validateJevQuestion, type CustomJevQuestion } from '@shared/jevQuestion';

export { fromUserQuery } from '@shared/searchQuery';

export { RULE_SPEC_VERSION } from '@shared/ruleVersion';
export { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
export { contentSummary, type ContentKind } from '@shared/messageContent';
export { plainDiscordText } from '@shared/discordText';

export { avatarUrl, mediaSize } from '@shared/media';

export type { AppUsage, PlanUsageWindow, TokenUsage } from '@shared/contract';

export {
  ALL_DAYS,
  DEFAULT_AWAY_HOURS,
  DEFAULT_DAILY_AT,
  TIMED_HOURS_MAX,
  TIMED_HOURS_MIN,
  WEEKDAY_LABELS,
  lastDailyDue,
  newTimedTrigger,
  timedTriggerError,
  timedTriggerText,
  type TimedTrigger,
  type TimedTriggerKind,
} from '@shared/ruleTime';
export { newGates } from '@shared/ruleGates';

export { ACTION_LOOKBACKS } from '@shared/ruleLookback';

export { visibleTableName as visibleTable, type ArchiveRef } from '@shared/archiveRefs';

// Notices, the pages served outside the app, and the phone's composer and directory shapes.
export type { Notice, NoticeKind } from '@shared/notices';
export {
  APNS_ENVIRONMENTS,
  SHELL_BUNDLE_ID,
  SHELL_CAPABILITIES,
  isApnsEnvironment,
  SHELL_ASSET_SCHEME,
  SHELL_NATIVE_GLOBAL,
  SHELL_PHOTOS_PAGE_MAX,
  SHELL_USER_AGENT_TOKEN,
  shellCapabilities,
  shellHas,
  shellPairLink,
  type ApnsEnvironment,
  type ShellCapability,
} from '@shared/shell';
export { ARCHIVE_DENSITIES, THEME_IDS, THEME_LABELS, type ArchiveDensity, type ThemeId } from '@shared/settings';
export { normalizeArchivePlace, type ArchivePlace } from '@shared/archivePlace';
export {
  DEFAULT_PHONE_LOOK,
  PHONE_LOOK_KEYS,
  PHONE_TEXT_SIZES,
  normalizePhoneLook,
  phoneLookEvent,
  phoneLookSetting,
  phoneLookWrite,
  type PhoneLook,
  type PhoneTextSize,
} from '@shared/phoneLook';
// Discord's Chat settings: the account's (synced) and each device's own; the settings a phone keeps for itself.
export {
  DEFAULT_DEVICE_CHAT_RECORD,
  DEFAULT_DEVICE_CHAT_SETTINGS,
  DEFAULT_DISCORD_CHAT_SETTINGS,
  SPOILER_MODES,
  SPOILER_MODE_LABELS,
  SWIPE_ACTIONS,
  SWIPE_ACTION_LABELS,
  VIDEO_QUALITIES,
  VIDEO_QUALITY_LABELS,
  normalizeDeviceChatRecord,
  type DeviceChatRecord,
  type DeviceChatSettings,
  type DiscordChatSettings,
  type SpoilerMode,
  type SwipeAction,
  type SyncedChatSettings,
  type VideoQuality,
} from '@shared/chatSettings';
export { PHONE_DEVICE_SETTINGS, isPhoneDeviceSetting } from '@shared/phoneDevice';
export type { OwnerMessage } from '@shared/compose';
export type { DirectoryGuild } from '@shared/contract';
