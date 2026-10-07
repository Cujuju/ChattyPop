// First-party renderer kit exposes themed UI props, formatters, state and navigation. Unversioned with host; excludes plugin registry dependencies.

import { setSettingsOpen } from '@/state/ui';

// UI kit.
export { TopBarButton } from '@/frame/TopBarButton';
export { StatusBarItem } from '@/panels/status-bar/StatusBarItem';
export { HoverBarButton } from '@/panels/chat/HoverBarButton';
export { Select } from '@/ui/Select';
export { Switch } from '@/ui/Switch';
export { HeaderActions, HeaderBadge, HeaderButton, HeaderMeta, PanelHeader, type HeaderButtonVariant } from '@/ui/PanelHeader';
export { createAction } from '@/ui/action';
export {
  clockTime,
  countText,
  errorText,
  formatBytes,
  formatTokens,
  localRange,
  percentText,
  planPercentText,
  shortDate,
  shortDateTime,
  toLocalInput,
  usdText,
  weekdayDate,
  weekdayDateTime,
} from '@/ui/format';
export { DayDivider, dayLabel } from '@/ui/DayDivider';
export { JumpToNewest } from '@/ui/JumpToNewest';
export { createFollowBottom } from '@/ui/followBottom';
export { scrolledFromTop } from '@/ui/scrollEdges';
export { createVirtualLog } from '@/ui/virtualLog';
export { VirtualRows } from '@/ui/VirtualRows';
export { createPagedList, keyedById } from '@/state/paged';
// Messages drawn as the Archive draws them.
export { MessageRow } from '@/panels/chat/MessageRow';
export { Embeds, isMediaOnly } from '@/panels/chat/MessageExtras';
// A person named in a plugin's text: their name as Discord draws it in a place, kept current, opening their profile.
export { PersonName } from '@/panels/chat/PersonName';
export { Card, choiceOptions, ErrorNote, Note, Page, Row, SectionsPage, SettingsButton, type ChoiceText } from '@/views/settings/SettingsLayout';
export { EffortRow, ModelRow } from '@/views/settings/ModelRows';
export { ModelList, modelTraits } from '@/views/settings/ModelList';
export { ProviderSelect } from '@/views/settings/ProviderSelect';
export { ModelRows, type ModelRowsProps, type ProviderModels } from '@/views/settings/FeatureModelRows';
export { ChipField, RemovableChip } from '@/views/settings/rules/TermChips';
// How things look (§14): the theme's look vocabulary; a plugin's own CSS modules hold structure only.
export { look } from '@/theme/look';
export { LinkButton } from '@/views/settings/rules/PatternBuilder';
export { Checks, Field, RuleBadge } from '@/views/settings/rules/fields';
export { AddPicker, ChipRow } from '@/views/settings/rules/pickers';
export { RuleLookback } from '@/views/settings/rules/RuleLookback';
export { JevQuestionField, conditionWording } from '@/ui/JevQuestionField';
export { InlineMarkdown } from '@/ui/Markdown';
export { listen, onPointerDownOutside } from '@/ui/listen';
export { AnimatedImage, EmojiImage } from '@/ui/AnimatedImage';
export { loopWhileLooking } from '@/ui/looking';
export { SearchSelect } from '@/ui/SearchSelect';
export { EffortSelect, hasEffortChoice, keptEffort } from '@/views/settings/EffortSelect';
export { SectionGlyph, SectionIcon } from '@/ui/SectionIcon';
export { Icon } from '@/ui/icons';
export { QrCode } from '@/ui/QrCode';
export { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
export { unreadCount, totalUnreadCount } from '@/state/unreadCounts';

// App state and navigation.
export { archivePlace, openArchive, openArchiveAt, shownChannelId, type ArchivePlace } from '@/state/archive';
export { now } from '@/state/clock';
// Which bots count as new messages (Settings → Archive → New-message counts).
export { countedBots, countedBotsLoaded, createArchivedBots, setBotCounted } from '@/state/countedBots';
export { archivedChannels, channelById, channelLabel, channelSigil, directory, isThread, loadDirectory } from '@/state/directory';
export { isPanelCollapsed, revealPanel, showPanel } from '@/state/layout';
export { openPerson } from '@/state/person';
export { personName } from '@/state/personNames';
export { aiSettings, appearanceSettings, providerName, providerSettingsOf, providerStatus, refetchProviderStatus, setProviderDisplayName } from '@/state/preferences';
export { openRule, rules, startNewRule } from '@/state/rules';
export { inCompanion, openSettingsAt, type IconName, type MenuGroup, type MenuItem } from '@/state/ui';
// In-app camera captures, saved to the phone's Photos when its chat settings ask.
export { saveCameraCaptures } from '@/phone/cameraCaptures';
// The phone's Photos library through the iPhone app, for the composer's attach sheet.
export {
  manageLimitedPhotos,
  onPhotoLibraryChange,
  photoAccess,
  photoFile,
  photoLibraryOffered,
  photoThumbUrl,
  recentPhotos,
  requestPhotoAccess,
  type PhotoAccess,
  type PhotoAsset,
  type PhotoPage,
} from '@/phone/photoLibrary';
/** Opens Settings where the owner left it. */
export const openSettings = (): void => void setSettingsOpen(true);
export { usdPerQuestion, projectedJevUsd } from '@/state/jevSpend';
export { querySearch, setSearchOpen } from '@/state/search';
export { openMessageMenuById } from '@/state/messageActions';
export { showJevQuery } from '@/state/jevNavigation';
export { jevSwitch, type JevSwitch } from './jevSwitch';
// Discord's Chat settings as this device shows them (Settings → Chat), and the double-tap emoji's choice.
export { changeDeviceChatSettings, changeDiscordChatSettings, deviceChatSettings, discordChatSettings, setSyncAcrossClients } from '@/state/chatSettings';
export { ChatEmoji, DoubleTapEmojiPicker } from '@/views/settings/DoubleTapEmoji';
export { lastPlanUsageOf, planUsageFailureOf, planUsageLoadingOf, planUsageOf, refetchPlanUsage, usageReporters } from '@/state/providerUsage';
// AI providers (docs/plugin-architecture.md §3, AI providers).
export { availableProviders as aiProviders, localProviderNames, providerRuns } from '@/state/aiProviders';
export { providerLabel } from '@shared/aiProviders';
/** ChattyPop's AI-run vocabulary as the active owner declares it, else generic. */
export { aiText } from '@/plugins/presentation';
