// Plugin SDK, posting tier (docs/plugin-architecture.md §4): public state and host UI a posting plugin's message box,
// hover actions and menu items use. Writes still meet main's posting lock.

// The draft, its send paths and the outbox.
export {
  attachFiles,
  composerFocus,
  customEmojiToken,
  draftError,
  draftFiles,
  draftText,
  mentionCandidateToken,
  removeFile,
  sendDraft,
  sendGif,
  setDraftText,
  type DraftFile,
} from '@/state/composer';
export { discardSend, dismissSending, editSend, outgoing, retrySend, sendingDismissed, type Outgoing } from '@/state/outbox';

// Slash commands: the menu, the command being filled in, and its options.
export { commandsError, commandsLoading, menuSections, openCommandMenu, searchEntities, type MenuItem as CommandMenuItem, type MenuSection as CommandMenuSection } from '@/state/commands';
export {
  addOption,
  cancelCommand,
  commandDraft,
  commandReady,
  missingOptions,
  pickOption,
  removeOption,
  runCommand,
  setCommandTail,
  setOptionFile,
  setOptionText,
  startCommand,
  suggest,
  unfinishedOptions,
} from '@/state/commandDraft';
export { entityKind, entityQuery, listedChoices, optionalLeft, picksFromList, type FilledOption } from '@/state/commandOptions';
export { OPTION, type CommandOption } from '@shared/commands';

// A message's own actions: edit, reply, forward, delete; each `can*` says whether it applies.
export { canDelete, canEdit, deleteMessage, editingId, lastEditable, startEdit } from '@/state/ownMessages';
export { canReply, cancelReply, replyPing, replyTarget, setReplyPing, startReply } from '@/state/reply';
export { canForward, startForward } from '@/state/forward';
export { isPrivateThread } from '@/state/directory';

// Expressions and mentions the box suggests and picks.
export {
  EMOJI_SUGGEST_MIN_CHARS,
  emojiSuggestions,
  expressionCatalog,
  loadExpressions,
  loadUnicodeEmojiData,
  loaded,
  searchGifs,
  type EmojiSuggestion,
} from '@/state/expressions';
export { cancelMemberRequest, membersVersion, mentionSuggestions, requestMembers } from '@/state/mentions';
export { canUseSticker, typedBuiltin, type Gif, type GuildSticker, type Sticker } from '@shared/compose';
export type { MentionCandidate } from '@shared/contract';
export { appIconUrl, gifPreviewUrl } from '@shared/media';
export { anyNameMatches } from '@shared/nameMatch';

// Host UI the box reuses: the emoji tabs and picker parts the reaction picker shares, icons, keys and list navigation.
export { ServerEmojiTab, SystemEmojiTab, type EmojiPick } from '@/panels/chat/compose/EmojiTab';
export { PickerSearch, PickerSection, guildOrder, normalQuery } from '@/panels/chat/compose/PickerParts';
export { hexColor } from '@/panels/chat/MessageExtras';
export { StickerArt } from '@/ui/StickerArt';
export { SolidIcon, type SolidIconName } from '@/ui/solidIcons';
export { enterSends, enterToSend } from '@/ui/enterToSend';
export { createListNav, type ListNav } from '@/ui/listNav';
