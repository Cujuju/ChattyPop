// Renderer SDK exposes contributions, clients, resources, settings/state/events through API leaves and shared code. Excludes plugin registry/host stores; kit supplies UI, shell supplies phone plumbing.
import { api } from '@/api';
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import { pluginSettingKey } from '@shared/bundledTypes';
import { preferenceOf, type Preference, type PreferenceNames, type PreferenceValue } from '@shared/preferences';
import type { EventsOf, MembersFor } from '@shared/pluginChannels';
import type { AppUsage } from '@shared/contract';
import type { ProviderId } from '@shared/settings';
import type { RendererContributions, RendererPlugin } from '@/plugins/define';
import { onPluginEvent } from './appEvents';
import { pluginActive } from './pluginList';
import { createSetting, type SettingExtras, type SettingOptions } from './settings';

export type { PanelView, ProviderView, RendererContributions, RendererPlugin, SettingsView } from '@/plugins/define';
export type { ComposerCommand, MessageMenuScope, RuleTemplate, UnreadSource } from '@/plugins/bundledTypes';
export type { KindProps, KindView, FilterView } from '@/views/settings/rules/kinds/types';
export type { TopBarView, PhoneSectionView, PhoneSectionPlace, PhoneDrawerView, ProviderRowView, StatusBarView, TopBarItem, PhoneSection, PhoneDrawerItem, NotificationKind, NotificationKindView, FrameContributions, ProviderRow, StatusBarContribution } from '@/plugins/frameSlots';
export type { MessageMenuView, PersonLinksView, PersonSectionView } from '@/plugins/readSlots';
export type { AttachmentBarView, ChatFooterProps, ChatFooterView, HoverBarView } from '@/plugins/messageSlots';
export type { Placement } from '@shared/anchors';
export type { JevFeatureView } from '@/views/settings/jevFeatures';
export {
  HOST_TOP_BAR_ITEMS,
  HOST_PHONE_SECTIONS,
  HOST_PHONE_DRAWER_ITEMS,
  HOST_PROVIDER_ROWS,
  HOST_STATUS_BAR_ITEMS,
  HOST_CHAT_FOOTER_ITEMS,
  HOST_HOVER_EMOJI_ITEMS,
  HOST_HOVER_ACTIONS,
} from '@shared/anchors';

/** Descriptor-derived renderer contributions cover declared views/slots. NoInfer ensures callback parameter types come from descriptor slots. */
export const defineRendererPlugin = <const D extends PluginDescriptor>(plugin: D, contributions: NoInfer<RendererContributions<D>>): RendererPlugin<D> => ({
  plugin,
  contributions,
});

// Channels (§5).
export { coreClient, desktopCoreClient, mainClient, phoneCoreClient, type WindowAudience, type WindowClient, type WindowMember } from './clients';
export { callable } from './pluginList';
export { pluginResource, type PluginResource } from './resource';
export { pluginData } from './data';
export { PluginInactiveError } from '@shared/pluginCall';
export { failure, settled } from './settled';

type WindowEvents<D> = MembersFor<ChannelsOf<D>, 'events', 'renderer' | 'phone'>;
/** Core's event `name` for windows; returns an unsubscribe function. */
export const onEvent = <D extends PluginDescriptor, K extends keyof WindowEvents<D> & string>(
  plugin: D,
  name: K,
  fn: (payload: EventsOf<ChannelsOf<D>>[K]) => void,
): (() => void) => onPluginEvent(plugin.manifest.id, name, (payload) => fn(payload as EventsOf<ChannelsOf<D>>[K]));

// Settings and plugin state.
/** The plugin's preference `name` as its descriptor declares it (plugin.<id>.<name>), shared with its core and main sides and every window. */
export function pluginPreference<D extends PluginDescriptor, const N extends PreferenceNames<D>>(
  plugin: D,
  name: N,
  opts?: SettingOptions<PreferenceValue<D, N>>,
): [() => PreferenceValue<D, N>, (v: PreferenceValue<D, N>) => void, SettingExtras<PreferenceValue<D, N>>] {
  // The declaration's normalize produces every value, so each has the declared type.
  const p = preferenceOf(plugin, name) as Preference<PreferenceValue<D, N>>;
  return createSetting(pluginSettingKey(plugin.manifest.id, name), p.default, (v) => p.normalize(v), opts);
}
export { sameIds, type SettingExtras, type SettingOptions } from './settings';
export { pluginsLoaded } from './pluginList';
/** Whether `plugin` is on (built in and not turned off); true before the plugin list loads. Reactive. */
export const isActive = (plugin: PluginDescriptor): boolean => pluginActive(plugin.manifest.id);

// App events and session facts.
export { ARCHIVE_REFRESH_DEBOUNCE_MS, onAppEvent, onAppEventDebounced, onMessagePartsChanged } from './appEvents';
/** When the previous app session was last seen: a watermark's first value ("since you were last here"). */
export const lastSeenAt = (): Promise<number> => api.core.lastSeenAt();
/** ChattyPop's completed AI runs and tokens on `provider` since `sinceTs`: every plugin's ctx.ai.usage, summed. */
export const aiUsageSince = (provider: ProviderId, sinceTs: number): Promise<AppUsage> => api.core.aiUsageSince(provider, sinceTs);
