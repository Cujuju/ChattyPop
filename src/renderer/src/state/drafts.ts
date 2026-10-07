// Per-channel text/files/entity selections persist in IndexedDB on changes and survive reloads/quits. composer.ts sends drafts.
import { createStore } from 'solid-js/store';
import { UPLOAD_BYTES_CEILING, emojiToken, mentionToken, type MentionPick } from '@shared/compose';
import type { ArchiveMessage, MentionCandidate } from '@shared/contract';
import { DISCORD_FILES_PER_MESSAGE_MAX } from '@shared/discord';
import type { CustomEmoji } from '@shared/emoji';
import { mediaKind } from '@shared/media';
import { BYTES_PER_MB } from '@shared/units';
import { api } from '@/api';
import { idbEntries, idbSet } from '@/ui/idbStore';
import { restoreReply } from './reply';

/** A file attached to a draft; `previewUrl` is a blob: URL for images and videos, else null. */
export interface DraftFile {
  id: number;
  file: File;
  previewUrl: string | null;
}

interface Draft {
  text: string;
  files: DraftFile[];
  /** Why files offered weren't all attached. */
  error: string | null;
}

/** A draft taken out to send: plain data (Files by reference), so IndexedDB and the outbox can keep it for Edit. */
export interface SavedDraft {
  text: string;
  files: File[];
  /** Picked custom emoji by the token shown in the text. */
  emoji: [string, CustomEmoji][];
  /** Picked people and roles by the `@token` shown in the text; absent from drafts saved before mentions. */
  mentions?: [string, MentionPick][];
  /** The message it answered. */
  reply: ArchiveMessage | null;
}

type SavedText = Pick<SavedDraft, 'text' | 'emoji' | 'mentions'>;
/** Text and files are kept apart, so typing doesn't rewrite the files. */
const TEXT_KEY = 'draft-text:';
const FILES_KEY = 'draft-files:';

const [drafts, setDrafts] = createStore<Record<string, Draft>>({});
/** Custom emoji, people and roles picked into each channel's draft, by the token shown in its text; read only when sending. */
const picked = new Map<string, Map<string, CustomEmoji>>();
const mentioned = new Map<string, Map<string, MentionPick>>();
let nextFileId = 0;

function tokensIn<T>(byChannel: Map<string, Map<string, T>>, channelId: string): Map<string, T> {
  let m = byChannel.get(channelId);
  if (!m) byChannel.set(channelId, (m = new Map()));
  return m;
}
const pickedIn = (channelId: string): Map<string, CustomEmoji> => tokensIn(picked, channelId);
const mentionedIn = (channelId: string): Map<string, MentionPick> => tokensIn(mentioned, channelId);
const ensure = (channelId: string): void => {
  if (!drafts[channelId]) setDrafts(channelId, { text: '', files: [], error: null });
};
const previewable = (f: File): boolean => f.type.startsWith('image/') || f.type.startsWith('video/');
const toDraftFile = (file: File): DraftFile => ({ id: nextFileId++, file, previewUrl: previewable(file) ? URL.createObjectURL(file) : null });
const revoke = (f: DraftFile): void => {
  if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
};

export const draftText = (channelId: string): string => drafts[channelId]?.text ?? '';
export const draftFiles = (channelId: string): DraftFile[] => drafts[channelId]?.files ?? [];
export const isDraftEmpty = (channelId: string): boolean => !draftText(channelId) && !draftFiles(channelId).length;
/** Why the last files offered weren't all attached (over the size or count limit). */
export const draftError = (channelId: string): string | null => drafts[channelId]?.error ?? null;

/** Copies, since a picker's emoji may be a store proxy, which IndexedDB can't clone. */
const emojiEntries = (channelId: string): [string, CustomEmoji][] => [...pickedIn(channelId)].map(([token, e]) => [token, { id: e.id, name: e.name, animated: e.animated }]);
const mentionEntries = (channelId: string): [string, MentionPick][] => [...mentionedIn(channelId)];
const saveText = (channelId: string): void =>
  idbSet(TEXT_KEY + channelId, draftText(channelId) ? ({ text: draftText(channelId), emoji: emojiEntries(channelId), mentions: mentionEntries(channelId) } satisfies SavedText) : undefined);
const saveFiles = (channelId: string): void => {
  const files = draftFiles(channelId).map((f) => f.file);
  idbSet(FILES_KEY + channelId, files.length ? files : undefined);
};

export function setDraftText(channelId: string, text: string): void {
  ensure(channelId);
  setDrafts(channelId, 'text', text);
  saveText(channelId);
}

/** The `:token:` to insert for a picked custom emoji; sending turns it into Discord's markup. */
export const customEmojiToken = (channelId: string, e: CustomEmoji): string => emojiToken(e, pickedIn(channelId));
/**
 * The `@token` to insert for a picked `@` suggestion: a person's username or a role's name, which sending turns into
 * Discord's mention; @everyone and @here go as typed.
 */
export function mentionCandidateToken(channelId: string, c: MentionCandidate): string {
  if (c.kind === 'everyone' || c.kind === 'here') return `@${c.kind}`;
  if (c.kind === 'role') return mentionToken(c.name, { id: c.id, kind: c.kind }, mentionedIn(channelId));
  return mentionToken(c.username ?? c.name, { id: c.id, kind: c.kind, name: c.name }, mentionedIn(channelId));
}

/** Files a draft may take: within the channel's upload limit, or a video, which sending shrinks to this device's quality. */
const uploadable = (f: File, limit: number): boolean => f.size <= limit || mediaKind({ contentType: f.type, filename: f.name }) === 'video';

/** Each channel's upload limit as last heard from the desktop, refreshed on every attach. */
const limits = new Map<string, number>();
const refreshLimit = (channelId: string): void =>
  void api.discord.uploadLimit(channelId).then(
    (limit) => limits.set(channelId, limit),
    () => undefined,
  );

/**
 * Attaches files (picked, pasted or dropped) to the draft at once, as many as Discord's limits allow; see draftError.
 * Synchronous so a send right after keeps them with its text. Until the channel's limit is known it assumes the ceiling;
 * the desktop still refuses an oversized file when the message is sent.
 */
export function attachFiles(channelId: string, files: File[]): void {
  ensure(channelId);
  refreshLimit(channelId);
  const limit = limits.get(channelId) ?? UPLOAD_BYTES_CEILING;
  const room = DISCORD_FILES_PER_MESSAGE_MAX - draftFiles(channelId).length;
  const fitting = files.filter((f) => uploadable(f, limit));
  const added = fitting.slice(0, Math.max(0, room)).map(toDraftFile);
  setDrafts(channelId, 'files', (fs) => [...fs, ...added]);
  setDrafts(
    channelId,
    'error',
    fitting.length < files.length
      ? `Discord takes files up to ${Math.round(limit / BYTES_PER_MB)} MB here.`
      : added.length < fitting.length
        ? `Discord takes up to ${DISCORD_FILES_PER_MESSAGE_MAX} files per message.`
        : null,
  );
  saveFiles(channelId);
}

export function removeFile(channelId: string, id: number): void {
  const f = draftFiles(channelId).find((x) => x.id === id);
  if (f) revoke(f);
  setDrafts(channelId, 'files', (fs) => fs.filter((x) => x.id !== id));
  saveFiles(channelId);
}

/** Empties the channel's draft (to send it) and returns it; `reply` is the message it answers. */
export function takeDraft(channelId: string, reply: ArchiveMessage | null): SavedDraft {
  ensure(channelId);
  const taken: SavedDraft = { text: draftText(channelId), files: draftFiles(channelId).map((f) => f.file), emoji: emojiEntries(channelId), mentions: mentionEntries(channelId), reply };
  draftFiles(channelId).forEach(revoke);
  setDrafts(channelId, { text: '', files: [], error: null });
  picked.delete(channelId);
  mentioned.delete(channelId);
  saveText(channelId);
  saveFiles(channelId);
  return taken;
}

/** Puts a message that came back unsent into the channel's draft (Edit); false when the draft has something new in it. */
export function restoreDraft(channelId: string, d: SavedDraft): boolean {
  if (!isDraftEmpty(channelId)) return false;
  setDrafts(channelId, { text: d.text, files: d.files.map(toDraftFile), error: null });
  picked.set(channelId, new Map(d.emoji));
  mentioned.set(channelId, new Map(d.mentions));
  if (d.reply) restoreReply(d.reply);
  saveText(channelId);
  saveFiles(channelId);
  return true;
}

/** Brings back the drafts kept before a reload; a draft typed into since stays as it is. */
async function loadSaved(): Promise<void> {
  const [texts, files] = await Promise.all([idbEntries<SavedText>(TEXT_KEY), idbEntries<File[]>(FILES_KEY)]);
  for (const [key, t] of texts) {
    const channelId = key.slice(TEXT_KEY.length);
    if (draftText(channelId)) continue;
    ensure(channelId);
    setDrafts(channelId, 'text', t.text);
    picked.set(channelId, new Map(t.emoji));
    mentioned.set(channelId, new Map(t.mentions));
  }
  for (const [key, fs] of files) {
    const channelId = key.slice(FILES_KEY.length);
    if (draftFiles(channelId).length) continue;
    ensure(channelId);
    setDrafts(channelId, 'files', fs.map(toDraftFile));
  }
}
void loadSaved();
