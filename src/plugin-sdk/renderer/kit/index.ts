// First-party renderer kit exposes themed UI props, formatters, state and navigation. Unversioned with host; excludes plugin registry dependencies.

import { setSettingsOpen } from '@/state/ui';

// UI kit.
export { TopBarButton } from '@/frame/TopBarButton';
export { StatusBarItem } from '@/panels/status-bar/StatusBarItem';
export { HoverBarButton } from '@/panels/chat/HoverBarButton';
export { FileIcon } from '@/panels/chat/FileIcon';
export { Select } from '@/ui/Select';
export { Switch } from '@/ui/Switch';
export { HeaderActions, HeaderBadge, HeaderButton, HeaderMeta, PanelHeader, type HeaderButtonVariant } from '@/ui/PanelHeader';
export { RollupControls } from './RollupControls';
export { createAction } from '@/ui/action';
// The app's own confirmation and notice dialogs, in place of the browser's unthemed confirm() and alert().
export { confirmDialog, failureNotice, noticeDialog, type ConfirmOptions, type NoticeOptions } from '@/state/dialogs';
// Exports: saved on the desktop, opened in the phone's browser; a PDF is one page the desktop draws.
export { exportHtmlPage, exportPdfPage, type HtmlPage, type PdfPage } from '@/ui/exportPage';
// A view as a self-contained page drawn as the app draws it, for those exports.
export { snapshotPage } from '@/ui/snapshot';
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
export { Avatar, MessageRow } from '@/ui/MessageRow';
export { AuthorName } from '@/panels/chat/AuthorName';
export { Embeds, isMediaOnly } from '@/panels/chat/MessageExtras';
// A person named in a plugin's text: their name as Discord draws it in a place, kept current, opening their profile;
// their avatar; a picker option drawing both.
export { PersonFace, PersonName, personOption } from '@/panels/chat/PersonName';
export { Card, choiceOptions, ErrorNote, Note, Page, Row, SectionsPage, SettingsButton, type ChoiceText } from '@/views/settings/SettingsLayout';
// Sections beside a rail or picker, with selection owned by the caller.
export { SectionSplit, type SectionDef } from '@/views/settings/SettingsLayout';
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
export { InlineMarkdown, Markdown } from '@/ui/Markdown';
export { GfmMarkdown } from '@/ui/mdDocument';
export { listen, onPointerDownOutside } from '@/ui/listen';
// A phone sheet's pull down to close, as the message menu's.
export { pullToClose } from '@/ui/pullToClose';
export { AnimatedImage, EmojiImage } from '@/ui/AnimatedImage';
// Image previews use the host's cached media routes and embedded Discord session.
export { attachmentUrl, attachmentThumbUrl, attachmentPosterUrl, mediaKind, mediaType, proxiedUrl, thumbUrl } from '@shared/media';
export { canSave as canSaveAttachment, saveAttachment as saveAttachmentFile } from '@/state/savedFiles';
export { canSaveAttachmentsToFolder, saveAttachmentsToFolder, showAttachmentFolder, startFileDrag, type FolderSaveProgress, type FolderSaveResult } from '@/state/attachmentExports';
export { compressStored, compressibleAs, canCompressHere, freeStored, type StoredAttachmentRef, type CompressOutcome, type CompressAs } from '@/state/storedAttachments';
export { setLightbox } from '@/state/ui';
export type { LightboxImage, LightboxGallery } from '@/state/ui';
export { loopWhileLooking } from '@/ui/looking';
export { SearchSelect, type SearchOption } from '@/ui/SearchSelect';
// A server's icon (initials when it has none), as the sidebar draws it.
export { GuildIcon } from '@/ui/GuildIcon';
// A DM's face as the DM list draws it: the person's avatar, a group's icon or two members.
export { DmFace } from '@/ui/DmFace';
export { EffortSelect, effortLabel, hasEffortChoice, keptEffort } from '@/views/settings/EffortSelect';
export { SectionGlyph, SectionIcon } from '@/ui/SectionIcon';
export { Icon } from '@/ui/icons';
export { SolidIcon, type SolidIconName } from '@/ui/solidIcons';
// A site's brand mark in text colour, with a globe for unknown hosts.
export { BrandIcon } from '@/ui/BrandIcon';
export { QrCode } from '@/ui/QrCode';
export { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
// A compact number stepper; the theme styles it (theme/bridge/pill-number-picker.css).
export { PillNumberPicker } from '@cujuju/solidjs-pill-number-picker';
// Drag to reorder a list; the theme styles its rows (theme/bridge/reorder-list.css).
export { createReorderList } from '@cujuju/solid-reorder-list';
export { unreadCount, totalUnreadCount } from '@/state/unreadCounts';

// App state and navigation.
export { archivePlace, openArchive, openArchiveAt, shownChannelId, type ArchivePlace } from '@/state/archive';
export { now } from '@/state/clock';
// Which bots count as new messages (Settings → Archive → New-message counts).
export { countedBots, countedBotsLoaded, createArchivedBots, setBotCounted } from '@/state/countedBots';
export { archivedChannels, channelById, channelLabel, channelSigil, directory, isThread, loadDirectory } from '@/state/directory';
export { isDmChannel, type DmChannel } from '@/state/dmRules';
// Threads folded under their channel in channel lists; one saved choice per channel, shared by every list.
export { foldGesture, showThreads, threadsShown, unseenInThreads } from '@/state/threadFolds';
export { FoldChevron, ThreadSpine, ThreadsBadge } from '@/ui/ThreadFold';
// Discord's server and channel columns as a place picker.
export { PlaceRail, type PlaceCounts, type PlaceRailProps, type RailPlace } from '@/ui/PlaceRail';
// The same place as one searchable picker, where a rail has no room (the phone).
export { PlaceSelect, type PlaceSelectProps } from '@/ui/PlaceSelect';
// A time window picker for filter bars and headers, and its window type.
export { TimeWindowSelect, type TimeWindowSelectProps } from '@/ui/TimeWindowSelect';
// A filter's "which of these to show" checklist menu under a plugin's own button.
export { FilterMenu, type FilterMenuItem, type FilterMenuProps } from '@/ui/FilterMenu';
export { TIME_PRESETS, isTimeRange, timeBounds, timeRangeLabel, type TimePreset, type TimeRange, type TimeWindow } from '@/ui/timeWindow';
export { isPanelCollapsed, revealPanel, showPanel } from '@/state/layout';
export { openPanel } from './openPanel';
// The SDK's openPerson keeps its optional place; the host's own requires one.
export { openPersonFromPlugin as openPerson } from '@/state/person';
// In-app windows a plugin opens per key, several of a kind at once (its renderer side's `windows`).
export { closePluginWindow, openPluginWindow, pluginWindowOpen } from '@/state/pluginWindows';
export { personName } from '@/state/personNames';
export { aiSettings, appearanceSettings, keepProviderStatusLoaded, providerName, providerSettingsOf, providerStatus, refetchProviderStatus, setProviderDisplayName } from '@/state/preferences';
export { openRule, ruleInputOf, rules, saveRule, startNewRule } from '@/state/rules';
export { inCompanion, openMenuAt, openSettingsAt, type IconName, type MenuGroup, type MenuItem } from '@/state/ui';
// In-app camera captures, saved to the phone's Photos when its chat settings ask.
export { saveCameraCaptures } from '@/phone/cameraCaptures';
// The phone's Photos library, photo picker and Files browser through the iPhone app, for the composer's attach sheet.
export {
  filePickerOffered,
  manageLimitedPhotos,
  onPhotoLibraryChange,
  photoAccess,
  photoFile,
  photoLibraryOffered,
  photoPickerOffered,
  photoThumbUrl,
  pickFiles,
  pickPhotos,
  recentPhotos,
  requestPhotoAccess,
  type PhotoAccess,
  type PhotoAsset,
  type PhotoPage,
} from '@/phone/photoLibrary';
/** Opens Settings where the owner left it. */
export const openSettings = (): void => void setSettingsOpen(true);
export { usdPerQuestion, projectedJevUsd } from '@/state/jevSpend';
export { querySearch, setSearchOpen, showSearch } from '@/state/search';
export { openMessageMenuById } from '@/state/messageActions';
export { showJevQuery } from '@/state/jevNavigation';
export { jevSwitch, type JevSwitch } from './jevSwitch';
// Discord's Chat settings as this device shows them (Settings → Chat), and the double-tap emoji's choice.
export { changeDeviceChatSettings, changeDiscordChatSettings, deviceChatSettings, discordChatSettings, setSyncAcrossClients } from '@/state/chatSettings';
export { ChatEmoji, DoubleTapEmojiPicker } from '@/views/settings/DoubleTapEmoji';
export { lastPlanUsageOf, planUsageFailureOf, planUsageLoadingOf, planUsageOf, refetchPlanUsage, usageReporters } from '@/state/providerUsage';
// AI providers (docs/plugin-architecture.md §3, AI providers).
export { availableProviders as aiProviders, localProviderNames, providerRuns } from '@/state/aiProviders';
export { providerLabel } from '@/state/preferences';
/** ChattyPop's AI-run vocabulary as the active owner declares it, else generic. */
export { aiText } from '@/plugins/presentation';
