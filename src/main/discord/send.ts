// Sending a message as the signed-in user, shaped as Discord's web client sends it.
import { checkPollDraft, pollPayload, type PollDraft } from '@shared/polls';
import type { DirectMessage, NewThread } from '@shared/commands';
import { ALT_TEXT_MAX, POST_WINDOW_PASSED, type KeptAttachment, type OwnerEdit, type OwnerFile, type OwnerForward, type OwnerMessage, type PostedOwnerMessage, type OwnerMessageRef, type OwnerReaction } from '@shared/compose';
import {
  DISCORD_FILES_PER_MESSAGE_MAX,
  DISCORD_TEXT_MAX,
  DISCORD_UPLOAD_BYTES_MAX,
  DM_GUILD_ID,
  PUBLIC_THREAD_TYPE,
  THREAD_NAME_MAX,
  isReactionEmoji,
  reactionPathPart,
  snowflakeArg,
  newNonce,
  typedMentions,
  type AllowedMentions,
  type RawMessage,
} from '@shared/discord';
import { errorMessage } from '@shared/errors';
import { PRIVATE_THREAD_TYPE } from '@shared/permissions';
import { BYTES_PER_MB } from '@shared/units';
import { diag } from '../diagnostics';
import type { DiscordWriter } from './client';
import type { Uploads } from './uploads';

/** A file uploaded to Discord's upload slot, as a message references it. */
export interface UploadedFile {
  id: string;
  filename: string;
  uploaded_filename: string;
}

export interface OutgoingMessage {
  content: string;
  allowedMentions: AllowedMentions;
  /** Makes it a Discord reply to this message. */
  replyTo?: { channelId: string; messageId: string } | null;
  /** Makes it a Discord forward of this message (content then stays empty). */
  forwardOf?: { guildId: string | null; channelId: string; messageId: string };
  /** Files already uploaded to Discord's upload slots. */
  attachments?: UploadedFile[];
  stickerIds?: string[];
  /** A poll, as checkPollDraft returned it. */
  poll?: PollDraft | null;
  /** The sender's, when it may retry; else a fresh one. */
  nonce?: string;
  /** Run before each post attempt, after any queue wait; throwing stops it unsent. */
  guard?: () => void;
}

export interface SentMessage {
  id: string;
  attachmentIds: string[];
  message: RawMessage;
}

/** Posts one message and resolves with its id and its attachments' ids. Its nonce is enforced, so a retried POST can't post twice. */
export async function sendMessage(api: DiscordWriter, channelId: string, m: OutgoingMessage): Promise<SentMessage> {
  const posted = await api.post<RawMessage & { attachments?: { id: string }[] }>(`channels/${channelId}/messages`, {
    content: m.content,
    nonce: m.nonce ?? newNonce(),
    enforce_nonce: true,
    tts: false,
    flags: 0,
    allowed_mentions: m.allowedMentions,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.stickerIds?.length ? { sticker_ids: m.stickerIds } : {}),
    ...(m.poll ? { poll: pollPayload(m.poll) } : {}),
    ...(m.replyTo ? { message_reference: { channel_id: m.replyTo.channelId, message_id: m.replyTo.messageId } } : {}),
    ...(m.forwardOf ? { message_reference: forwardReference(m.forwardOf) } : {}),
  }, m.guard ? { guard: m.guard } : undefined);
  return { message: posted, id: posted.id, attachmentIds: (posted.attachments ?? []).map((a) => a.id) };
}

/** Discord's message_reference type for a forward (0, the default, is a reply). */
const FORWARD_REFERENCE_TYPE = 1;

const forwardReference = (f: NonNullable<OutgoingMessage['forwardOf']>) => ({
  type: FORWARD_REFERENCE_TYPE,
  channel_id: f.channelId,
  message_id: f.messageId,
  ...(f.guildId ? { guild_id: f.guildId } : {}),
});

interface UploadSlot {
  /** The `id` sent for the file (its index). */
  id: number | string;
  upload_url: string;
  upload_filename: string;
}

/** A file for one message, as sent. */
export interface OutgoingFile {
  name: string;
  bytes: Buffer;
}

/** Uploads one message's files to slots Discord hands out, as the web client does; resolves with what the message references. */
export async function uploadFiles(api: DiscordWriter, channelId: string, files: OutgoingFile[]): Promise<UploadedFile[]> {
  if (!files.length) return [];
  const { attachments: slots } = await api.post<{ attachments: UploadSlot[] }>(`channels/${channelId}/attachments`, {
    files: files.map((f, i) => ({ id: String(i), filename: f.name, file_size: f.bytes.length, is_clip: false })),
  });
  const uploaded: UploadedFile[] = [];
  for (const slot of slots) {
    const f = files[Number(slot.id)];
    if (!f) throw new Error('Discord returned an unexpected upload slot.');
    await api.upload(slot.upload_url, f.bytes);
    uploaded.push({ id: String(slot.id), filename: f.name, uploaded_filename: slot.upload_filename });
  }
  return uploaded;
}

const isFile = (f: unknown): f is OwnerFile => {
  const o = f as Partial<OwnerFile> | null;
  return !!o && typeof o.name === 'string' && o.name.trim() !== '' && o.bytes instanceof Uint8Array;
};

/** `v` checked as an OwnerMessage (it comes from the renderer); throws the reason it can't be sent. */
export function checkOwnerMessage(v: unknown): OwnerMessage {
  const m = v as Partial<OwnerMessage> | null;
  if (!m || typeof m.text !== 'string' || !Array.isArray(m.files)) throw new Error('Not a message to send.');
  const channelId = snowflakeArg(m.channelId, 'channel');
  if (m.text.length > DISCORD_TEXT_MAX) throw new Error(`Discord allows ${DISCORD_TEXT_MAX} characters.`);
  const r = m.replyTo;
  const replyTo = r ? { messageId: snowflakeArg(r.messageId, 'message'), ping: r.ping === true } : null;
  if (!m.files.every(isFile)) throw new Error('Not a file to attach.');
  const uploads = m.uploads ?? [];
  if (!Array.isArray(uploads) || !uploads.every((t) => typeof t === 'string')) throw new Error('Not the uploads of a message.');
  if (m.files.length + uploads.length > DISCORD_FILES_PER_MESSAGE_MAX) throw new Error(`Discord takes up to ${DISCORD_FILES_PER_MESSAGE_MAX} files per message.`);
  const tooBig = m.files.find((f) => f.bytes.length > DISCORD_UPLOAD_BYTES_MAX);
  if (tooBig) throw new Error(`${tooBig.name} is over Discord's ${DISCORD_UPLOAD_BYTES_MAX / BYTES_PER_MB} MB upload limit.`);
  const stickerId = m.stickerId ? snowflakeArg(m.stickerId, 'sticker') : null;
  const g = m.gif;
  if (g && (typeof g.id !== 'string' || typeof g.query !== 'string')) throw new Error('Not a GIF to send.');
  const poll = m.poll ? checkPollDraft(m.poll) : null;
  if (!m.text.trim() && !m.files.length && !uploads.length && !stickerId && !poll) throw new Error('Write a message first.');
  const nonce = snowflakeArg(m.nonce, 'nonce');
  const w = m.postWithinMs;
  if (w !== undefined && !Number.isFinite(w)) throw new Error('Not a time to post within.');
  return { channelId, text: m.text, replyTo, files: m.files, uploads, stickerId, gif: g ? { id: g.id, query: g.query } : null, ...(poll ? { poll } : {}), nonce, ...(w === undefined ? {} : { postWithinMs: w }) };
}

/** Posts what the owner wrote in the Archive composer: uploads its small files, then the message with those and its finished uploads. */
export async function sendOwnerMessage(api: DiscordWriter, v: unknown, held?: Uploads): Promise<PostedOwnerMessage> {
  const m = checkOwnerMessage(v);
  // On this clock from now: the sender's own clock may differ.
  const deadline = m.postWithinMs === undefined ? null : Date.now() + m.postWithinMs;
  const guard = (): void => {
    if (deadline !== null && Date.now() >= deadline) throw new Error(POST_WINDOW_PASSED);
  };
  guard();
  const tokens = m.uploads ?? [];
  if (tokens.length && !held) throw new Error('Uploads are not taken here.');
  const uploaded = held?.take(m.channelId, tokens) ?? [];
  // The live client reports a picked GIF before sending it; a failed report doesn't stop the message.
  if (m.gif) await api.post('gifs/select', { id: m.gif.id, q: m.gif.query }).catch((err: unknown) => diag('gif-select-failed', { message: errorMessage(err) }));
  const small = await uploadFiles(api, m.channelId, m.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes) })));
  // Ids are each file's index in the message.
  const attachments = [...uploaded, ...small.map((f, i) => ({ ...f, id: String(uploaded.length + i) }))];
  const sent = await sendMessage(api, m.channelId, {
    content: m.text,
    allowedMentions: typedMentions(m.replyTo?.ping ?? false),
    replyTo: m.replyTo ? { channelId: m.channelId, messageId: m.replyTo.messageId } : null,
    attachments,
    stickerIds: m.stickerId ? [m.stickerId] : [],
    poll: m.poll ?? null,
    nonce: m.nonce,
    guard,
  });
  // Kept until Discord accepts the message: a retry (same nonce) reuses them.
  held?.release(tokens);
  return { nonce: m.nonce, message: sent.message };
}

/** `v` checked as an OwnerForward (it comes from the renderer); throws the reason it can't be sent. */
export function checkOwnerForward(v: unknown): OwnerForward {
  const f = v as Partial<OwnerForward> | null;
  if (!f || !f.source) throw new Error('Not a message to forward.');
  const source = checkMessageRef(f.source);
  const g = f.source.guildId;
  const guildId = g === null || g === undefined || g === DM_GUILD_ID ? null : snowflakeArg(g, 'server');
  return { source: { ...source, guildId }, channelId: snowflakeArg(f.channelId, 'channel'), nonce: snowflakeArg(f.nonce, 'nonce') };
}

/** Forwards a message as the web client does. The sender's nonce makes a retry safe: Discord dedupes it for a few minutes. */
export async function forwardAsOwner(api: DiscordWriter, v: unknown): Promise<void> {
  const f = checkOwnerForward(v);
  await sendMessage(api, f.channelId, { content: '', allowedMentions: typedMentions(false), forwardOf: f.source, nonce: f.nonce });
}

/** `v` checked as an OwnerMessageRef (it comes from the renderer); throws the reason it isn't one. */
function checkMessageRef(v: unknown): OwnerMessageRef {
  const r = v as Partial<OwnerMessageRef> | null;
  if (!r) throw new Error('Not a message.');
  return { channelId: snowflakeArg(r.channelId, 'channel'), messageId: snowflakeArg(r.messageId, 'message') };
}

/** `v` checked as an OwnerEdit (it comes from the renderer); throws the reason it can't be sent. */
export function checkOwnerEdit(v: unknown): OwnerEdit {
  const e = v as Partial<OwnerEdit> | null;
  if (!e || (e.text === undefined && e.attachments === undefined)) throw new Error('Not an edit to save.');
  const ref = checkMessageRef(e);
  if (e.text !== undefined && typeof e.text !== 'string') throw new Error('Not an edit to save.');
  if (e.text !== undefined && e.text.length > DISCORD_TEXT_MAX) throw new Error(`Discord allows ${DISCORD_TEXT_MAX} characters.`);
  return { ...ref, ...(e.text !== undefined ? { text: e.text } : {}), ...(e.attachments !== undefined ? { attachments: checkKeptAttachments(e.attachments) } : {}) };
}

/** `v` checked as the attachments a message keeps; throws the reason it isn't. */
function checkKeptAttachments(v: unknown): KeptAttachment[] {
  if (!Array.isArray(v) || v.length > DISCORD_FILES_PER_MESSAGE_MAX) throw new Error('Not the attachments to keep.');
  return v.map((a: Partial<KeptAttachment> | null) => {
    if (!a) throw new Error('Not an attachment to keep.');
    const id = snowflakeArg(a.id, 'attachment');
    if (a.change === undefined) return { id };
    const { description, spoiler } = a.change as Partial<NonNullable<KeptAttachment['change']>>;
    if (typeof description !== 'string' || typeof spoiler !== 'boolean') throw new Error('Not an attachment change.');
    if (description.length > ALT_TEXT_MAX) throw new Error(`Discord allows ${ALT_TEXT_MAX} characters of alt text.`);
    return { id, change: { description, spoiler } };
  });
}

/** An attachment as the web client's PATCH names it: kept ones by id; a modified one with its alt text and spoiler flag. */
const keptBody = (a: KeptAttachment): Record<string, unknown> =>
  a.change ? { id: a.id, description: a.change.description, is_spoiler: a.change.spoiler } : { id: a.id };

/**
 * Saves the owner's edit as the web client does: only what it names changes (the text, the kept attachments' list).
 * Discord refuses someone else's message.
 */
export async function editOwnerMessage(api: DiscordWriter, v: unknown): Promise<void> {
  const e = checkOwnerEdit(v);
  await api.patch(`channels/${e.channelId}/messages/${e.messageId}`, {
    ...(e.text !== undefined ? { content: e.text } : {}),
    ...(e.attachments ? { attachments: e.attachments.map(keptBody) } : {}),
  });
}

/** Deletes one of the owner's messages. Discord refuses someone else's (without Manage Messages). */
export async function deleteOwnerMessage(api: DiscordWriter, v: unknown): Promise<void> {
  const r = checkMessageRef(v);
  await api.delete(`channels/${r.channelId}/messages/${r.messageId}`);
}

/** `v` checked as an OwnerReaction (it comes from the renderer); throws the reason it isn't one. */
export function checkOwnerReaction(v: unknown): OwnerReaction {
  const r = v as Partial<OwnerReaction> | null;
  if (!r || typeof r.add !== 'boolean' || !isReactionEmoji(r.emoji)) throw new Error('Not a reaction.');
  return { ...checkMessageRef(r), emoji: { id: r.emoji.id, name: r.emoji.name, animated: r.emoji.animated }, add: r.add };
}

/** Adds (PUT) or takes back (DELETE) the owner's reaction, as the web client does; resolves with what was applied. */
export async function reactAsOwner(api: DiscordWriter, v: unknown): Promise<OwnerReaction> {
  const r = checkOwnerReaction(v);
  const path = `channels/${r.channelId}/messages/${r.messageId}/reactions/${reactionPathPart(r.emoji)}/@me`;
  await (r.add ? api.put(path) : api.delete(path));
  return r;
}

/** Starts a thread in a text channel (Discord's /thread; private when asked), then posts its first message when there is one. */
export async function createThread(api: DiscordWriter, v: unknown): Promise<void> {
  const t = v as Partial<NewThread> | null;
  if (!t || typeof t.name !== 'string' || typeof t.message !== 'string') throw new Error('Not a thread to start.');
  const channelId = snowflakeArg(t.channelId, 'channel');
  const name = t.name.trim();
  if (!name) throw new Error('Name the thread.');
  if (name.length > THREAD_NAME_MAX) throw new Error(`A thread name is at most ${THREAD_NAME_MAX} characters.`);
  if (t.message.length > DISCORD_TEXT_MAX) throw new Error(`Discord allows ${DISCORD_TEXT_MAX} characters.`);
  const type = t.private === true ? PRIVATE_THREAD_TYPE : PUBLIC_THREAD_TYPE;
  const thread = await api.postOnce<{ id: string }>(`channels/${channelId}/threads`, { name, type });
  if (t.message.trim()) await sendMessage(api, thread.id, { content: t.message, allowedMentions: typedMentions(false) });
}

/** Sends a direct message (Discord's /msg): the DM with that person through the DM service (`dmWith`, dms.ts), then the post. */
export async function sendDirect(api: DiscordWriter, dmWith: (userId: string) => Promise<string>, v: unknown): Promise<void> {
  const d = v as Partial<DirectMessage> | null;
  if (!d || typeof d.message !== 'string') throw new Error('Not a message to send.');
  const userId = snowflakeArg(d.userId, 'user');
  if (!d.message.trim()) throw new Error('Write a message first.');
  if (d.message.length > DISCORD_TEXT_MAX) throw new Error(`Discord allows ${DISCORD_TEXT_MAX} characters.`);
  await sendMessage(api, await dmWith(userId), { content: d.message, allowedMentions: typedMentions(false) });
}
