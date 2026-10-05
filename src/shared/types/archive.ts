// Archive data as the renderer and core exchange it: directory, messages, search hits, download queues.
import type { MessageComponent } from '../components';
import type { NameFont } from '../nameFonts';
import type { MessageAnnotation } from '../plugins';
import type { TextTier } from '../settings';

/** Storage health reported by the core process. */
export interface CoreStatus {
  sqliteVersion: string;
  /** Cipher compiled into SQLite3MultipleCiphers; encryption itself is off until a key is set. */
  cipher: string;
  encrypted: boolean;
  fts5: boolean;
  schemaVersion: number;
  dbPath: string;
  /** Database file plus its WAL/SHM side files. */
  dbBytes: number;
  /** Archived attachment files (each distinct file once). */
  mediaBytes: number;
  /** Everything ChattyPop stores on disk for the archive. */
  totalBytes: number;
  /** Database bytes over the text cap that retention may not remove (uncovered text); 0 when within it. */
  textOverCapBytes: number;
}

export interface DirectoryChannel {
  id: string;
  guildId: string;
  name: string;
  kind: number;
  parentId: string | null;
  optedIn: boolean;
  messageCount: number;
  /** Messages since the channel was last opened in the Archive (or since the previous app session). */
  newCount: number;
  /** Of those, messages Jev marked notable (0 unless catch-up badges ran). */
  notableCount: number;
  /** Unread messages that pinged the owner, as Discord's read state counts them (a read on any device clears it). */
  mentionCount: number;
  /** Newest archived message time; null when none. */
  lastTs: number | null;
  /** Local AI only in effect: the channel's own policy, or its parent's for a thread (core channelPolicy); see ChannelPolicy. */
  localAiOnly: boolean;
  textTier: TextTier | null;
  /** A one-to-one DM's other person: from Discord's DM list, else its newest message not the owner's. Null otherwise. */
  peer: { id: string; avatar: string | null } | null;
  /** A group DM's own icon hash; null for other channels and a group without one. */
  icon: string | null;
  /** Marked private: hidden with its threads while privacy mode is on. */
  hideInPrivacy: boolean;
  /** A DM or group DM's own state (kinds 1 and 3 only), from the client's gateway; docs/dms.md §3.4. */
  dm?: {
    recipients: { id: string; name: string; avatar: string | null }[]; // members without self, owner included; empty while unknown
    rosterKnown: boolean; // false: Discord hasn't named its members yet, so recipients says nothing of them
    ownerId: string | null;
    lastMessageId: string | null;
    ackId: string | null;
    muteEndsMs: number | null;
    closed: boolean;
    request: boolean;
    archived: 'never' | 'on' | 'stopped'; // 'stopped': not opted in, history kept
    preview: { authorName: string; text: string } | null; // newest message passing visibleMessageSql, text pruned per tier
  };
}

/** Per-channel policy set from the channel list. Omitted fields stay as they are. */
export interface ChannelPolicy {
  /** Messages only ever go to a local provider (declared `local`); other providers and Jev skip the channel. */
  localAiOnly?: boolean;
  /** Overrides Settings → Archive → Older messages; null = use that setting. */
  textTier?: TextTier | null;
  /** Hidden, with its threads, while privacy mode is on. */
  hideInPrivacy?: boolean;
}

/** What privacy mode hides right now; both empty while it is off. */
export interface PrivacyScope {
  guildIds: string[];
  /** Hidden channels, including threads and every channel of a hidden server. */
  channelIds: string[];
}

export interface ChannelInfo {
  kind: number;
  guildId: string | null;
}

export interface DirectoryGuild {
  id: string;
  name: string;
  /** Discord icon hash, or null when the server has no icon. */
  icon: string | null;
  /** Marked private: the server and all its channels are hidden while privacy mode is on. */
  hideInPrivacy: boolean;
  channels: DirectoryChannel[];
}

export interface IngestResult {
  inserted: number;
  edited: number;
  skipped: number;
}

export interface SyncState {
  channelId: string;
  oldestId: string | null;
  newestId: string | null;
  count: number;
  backfillComplete: boolean;
}

export interface ArchiveAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  /** Set once stored locally. */
  sha256: string | null;
  /** evicted: file pruned by the attachment cap (Settings → Archive); the row and its metadata remain. */
  status: 'pending' | 'stored' | 'failed' | 'evicted';
  /** Alt text. */
  description: string | null;
  /** Covered until clicked, as Discord's clients show it (shared/media.ts isSpoiler). */
  spoiler: boolean;
  /** It left its message on Discord (an edit removed it); the archive keeps it. */
  removed: boolean;
  /** Notes plugins attached (a transcript), in plugin build order. */
  notes: AttachmentNote[];
}

/** A plugin's note under an attachment or embed: a result, or where making it has got to. */
export interface AttachmentNote {
  pluginId: string;
  /** The message part it is of (core/messageParts.ts partKey): an attachment, an embed's media or its text. */
  part: string;
  /** What it is, for styling (data-kind), e.g. 'transcript'. */
  kind: string;
  /** Its progress, for styling (data-state); the plugin's own states. */
  state: string;
  label: string;
  text: string;
}

export interface ArchiveEmoji {
  /** null for a Unicode emoji (name is the character). */
  id: string | null;
  name: string;
  animated: boolean;
}

export interface ArchiveReaction {
  emoji: ArchiveEmoji;
  count: number;
  /** The owner's own (normal) reaction is among them. */
  me: boolean;
}

/**
 * Discord's unfurled preview of a link, or a bot's rich embed. Image URLs are Discord media-proxy URLs, or X image-host URLs
 * for an X post filled from FxTwitter (Links views only).
 */
export interface ArchiveEmbed {
  type: string;
  url: string | null;
  title: string | null;
  /** Discord markdown. */
  description: string | null;
  /** 0xRRGGBB side-bar colour, or null for the default. */
  color: number | null;
  provider: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  thumbnailUrl: string | null;
  thumbnailSize: MediaSize | null;
  imageUrl: string | null;
  imageSize: MediaSize | null;
  /**
   * A gallery's images after `imageUrl`: Discord sends a multi-photo post as embeds sharing one URL and draws them as one
   * card. Absent for a single image.
   */
  moreImages?: EmbedImage[];
  /** gifv/video: the proxied video file, played muted and looped like Discord's GIFs. */
  videoUrl: string | null;
  videoSize: MediaSize | null;
  footer: string | null;
  /**
   * Notes plugins attached to its text and media (a transcript, a translation), in plugin build order. Absent on an embed
   * a plugin builds itself (a Links card), including from builds before SDK 2.1.
   */
  notes?: AttachmentNote[];
}

/** One image of an embed's gallery. */
export interface EmbedImage {
  url: string;
  size: MediaSize | null;
}

/** A media file's pixel size as its source reports it: the view reserves the box before the file loads. */
export interface MediaSize {
  width: number;
  height: number;
}

export interface ArchiveSticker {
  id: string;
  name: string;
  /** 1 png, 2 apng, 3 lottie (not renderable), 4 gif. */
  formatType: number;
}

/** The message a reply points at, as shown on the reply line. */
export interface ArchiveReply {
  messageId: string;
  authorId: string;
  authorName: string;
  /** 0xRRGGBB of the author's highest coloured role in the server, as Discord colours the reply line's name; null for none. */
  authorColor: number | null;
  avatar: string | null;
  content: string;
  /** Names for users @mentioned in content. */
  mentions: Record<string, string>;
}

/** Tags Jev may put on a message. */
export const MESSAGE_TAGS = ['announcement', 'decision', 'plan', 'question'] as const;
export type MessageTag = (typeof MESSAGE_TAGS)[number];

/** A chip on a message from a Jev per-message question (tags, classes…) or an owner's tag: its subject, and the text shown. */
export interface MessageLabel {
  subject: string;
  text: string;
  title: string;
  pluginId?: string;
  key?: string;
  variant?: string;
}

/** What Discord draws with an author's name in a server: the member's current roles and the user's server tag. */
export interface AuthorStyle {
  /** 0xRRGGBB of the member's highest role with a colour; null for none (the default name colour). */
  color: number | null;
  /** That role's gradient (2 colours) or holographic style (3), when the server has Enhanced Role Styles; null otherwise. */
  gradient: number[] | null;
  /** The user's Nitro display-name font (shared/nameFonts.ts); null for the default face. */
  font: NameFont | null;
  /** The avatar decoration's asset hash; null for none. */
  decoration: string | null;
  /** The icon of the member's highest role that has one: an image hash or a unicode emoji. */
  roleIcon: { roleId: string; name: string; icon: string | null; emoji: string | null } | null;
  /** The server tag the user shows: its text and badge image hash. */
  tag: { guildId: string; text: string; badge: string | null } | null;
  /** An app (bot or webhook): Discord marks it APP, with a check when Discord verified it; null for a person. */
  app: { verified: boolean } | null;
}

/** A stored message as the Archive view renders it. */
export interface ArchiveMessage {
  id: string;
  channelId: string;
  ts: number;
  editedTs: number | null;
  deletedAt: number | null;
  /** Text retention removed the text and payload (an active coverage provider covers it); content is empty. */
  prunedAt: number | null;
  content: string;
  /** name: as Discord shows it in the server (nickname first); username: the account name; avatar: Discord avatar hash, null for the default avatar. */
  author: { id: string; name: string; username: string | null; avatar: string | null } & AuthorStyle;
  replyToId: string | null;
  /** Resolved from the archive, else from the copy Discord embedded; null when unknown or not a reply. */
  reply: ArchiveReply | null;
  reactions: ArchiveReaction[];
  /** Display names of users @mentioned in the text, by id. */
  mentions: Record<string, string>;
  /** Users the message pinged, as Discord reports it: @mentions, and a reply's author when the reply pings. */
  mentionIds: string[];
  /** An @everyone or @here that pinged. */
  mentionsEveryone: boolean;
  embeds: ArchiveEmbed[];
  stickers: ArchiveSticker[];
  /** Earlier versions, oldest first; the current text is `content`. */
  revisions: { content: string; editedTs: number | null; seenAt: number }[];
  attachments: ArchiveAttachment[];
  /** Notes on the text of links no card of it shows (a linked post's translation), drawn under its text. */
  notes: AttachmentNote[];
  /** Notes plugins attached to this message. */
  annotations: MessageAnnotation[];
  /** Chips from Jev's per-message questions that have a label for their stored answer (tags, classes…). */
  labels: MessageLabel[];
  /** Discord's message flags (MESSAGE_FLAG: only-you-can-see, still thinking…). */
  flags: number;
  /** The app its buttons and menus reach; null for a person's message. */
  applicationId: string | null;
  /** Buttons, select menus and the layout blocks of a component-only message. */
  components: MessageComponent[];
  /** Set on an app's reply to a slash command. */
  interaction: ArchiveInteraction | null;
}

/** Who ran which slash command, shown above the app's reply ("Ann used /roll"). `command` is null when Discord didn't say. */
export interface ArchiveInteraction {
  userId: string;
  userName: string;
  command: string | null;
}

/** Match delimiters in search snippets: control characters never appear in chat text, so splitting on them is safe. */
export const SEARCH_MATCH_START = '\u0002';
export const SEARCH_MATCH_END = '\u0003';

/** A full-text search result; `snippet` marks matches with SEARCH_MATCH_START/END. */
export interface SearchHit {
  messageId: string;
  channelId: string;
  channelName: string;
  authorName: string;
  ts: number;
  snippet: string;
  /** Display names of the users the message mentions, by id, for writing <@id> in the snippet. */
  mentions: Record<string, string>;
  /** A search ranker's probability that the hit answers the query, when a ranker placed it (ctx.search.rerank). */
  relevance?: number;
}

/** A channel's messages newer than its last-read mark: how many, and the oldest (the first unread). */
export interface UnreadMark {
  channelId: string;
  count: number;
  firstId: string;
  firstTs: number;
}

/**
 * A channel's unread mention count in Discord's read state (main/discord/readStates.ts), and a DM's read and mute state.
 * Each field is absent when unknown (or, for the DM fields, not a DM): the stored value stands.
 */
export interface ReadStateCount {
  channelId: string;
  mentionCount?: number;
  /** A DM's last read message; null when never read. */
  ackId?: string | null;
  /** When a DM's mute ends (ms; MUTED_FOREVER: until unmuted); null when not muted. */
  muteEndsMs?: number | null;
}

/**
 * How a batch of read states lands: 'merge' patches the listed channels; 'replace' (READY) lists every channel, so the
 * rest have none, and a listed channel keeps what its count leaves out; 'reset' (another account) also forgets that.
 */
export type ReadStateScope = 'merge' | 'replace' | 'reset';

export interface MessagePageQuery {
  channelId: string;
  limit: number;
  before?: string;
  /** Messages newer than this id, oldest first (paging toward the newest after a jump). */
  after?: string;
  around?: string;
}

export interface PendingEmoji {
  id: string;
  animated: boolean;
}

export interface PendingAttachment {
  id: string;
  messageId: string;
  channelId: string;
  url: string;
  filename: string;
}

/** One message's exchange, oldest first. `linkedIds`: joined to it by Discord replies; the rest grouped by time and participants. */
export interface ConversationView {
  messages: ArchiveMessage[];
  linkedIds: string[];
}
