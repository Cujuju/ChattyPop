import { DISCORD_TEXT_MAX, DiscordHttpError, snowflakeArg, typedMentions } from '@shared/discord';
import { pollPayload } from '@shared/polls';
import { SCHEDULE_LIMIT_CODE, SCHEDULE_UNCONFIRMED, SUPPRESS_NOTIFICATIONS, scheduleWindowError, scheduledContent, type ScheduledDraft, type ScheduledMessage, type ScheduledUpdate } from '@shared/scheduledMessages';
import { isPostingLocked } from '@shared/posting';
import type { DiscordClient } from './client';
import type { ScheduledAccount } from './scheduledAvailability';
import { checkOwnerMessage, uploadFiles } from './send';
import type { Uploads } from './uploads';

const PATH = 'users/@me/scheduled-messages';
const itemPath = (id: unknown): string => `${PATH}/${snowflakeArg(id, 'scheduled message')}`;

function checkTime(value: unknown, replyId?: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error('Choose a valid date and time.');
  const at = Date.parse(value);
  const error = scheduleWindowError(at, Date.now(), replyId);
  if (error) throw new Error(error);
  return new Date(at).toISOString();
}

export function checkScheduledDraft(value: unknown): ScheduledDraft {
  const message = checkOwnerMessage(value);
  const scheduledTimestamp = checkTime((value as Partial<ScheduledDraft>).scheduledTimestamp, message.replyTo?.messageId);
  const content = scheduledContent(message.text);
  if (!content.content.trim() && !message.files.length && !message.uploads?.length && !message.stickerId && !message.poll) throw new Error('Write a message first.');
  return { ...message, scheduledTimestamp };
}

export function checkScheduledUpdate(value: unknown, replyId?: string): ScheduledUpdate {
  const u = value as Partial<ScheduledUpdate> | null;
  if (!u || (u.scheduledTimestamp === undefined && u.content === undefined && u.flags === undefined)) throw new Error('Choose a time or edit the message.');
  const id = snowflakeArg(u.id, 'scheduled message');
  if (u.content !== undefined && (typeof u.content !== 'string' || u.content.length > DISCORD_TEXT_MAX)) throw new Error('Not valid message text.');
  if (u.flags !== undefined && (!Number.isSafeInteger(u.flags) || u.flags < 0 || u.flags > 0x7fffffff)) throw new Error('Not valid message flags.');
  return { id, ...(u.scheduledTimestamp === undefined ? {} : { scheduledTimestamp: checkTime(u.scheduledTimestamp, replyId) }),
    ...(u.content === undefined ? {} : { content: u.content }), ...(u.flags === undefined ? {} : { flags: u.flags }) };
}

/** All requests use the existing session client and posting gate. Creation has no deduplicating nonce. */
export class ScheduledMessages {
  constructor(private readonly api: DiscordClient, private readonly account: (channelId?: string) => Promise<ScheduledAccount>, private readonly uploads?: Uploads) {}

  async availability(channelId: unknown) {
    const { enabled, limit } = await this.account(snowflakeArg(channelId, 'channel'));
    return { enabled, limit };
  }

  private async guard(userId: string | null, channelId?: string): Promise<void> {
    const current = await this.account(channelId);
    if (!userId || current.userId !== userId) throw new Error('The Discord account changed. Refresh scheduled messages.');
    if (channelId && !current.enabled) throw new Error('Scheduled messages are unavailable in this channel.');
  }

  async list(): Promise<ScheduledMessage[]> {
    const account = await this.account();
    if (!account.userId) throw new Error('The live Discord account is not ready.');
    const items = await this.api.get<ScheduledMessage[]>(PATH, {}, { guard: () => this.guard(account.userId) });
    await this.guard(account.userId);
    if (!Array.isArray(items)) throw new Error('Discord returned an unexpected scheduled-message list.');
    return items.filter((item) => item.user_id === account.userId);
  }

  async create(value: unknown): Promise<ScheduledMessage> {
    const m = checkScheduledDraft(value);
    const account = await this.account(m.channelId);
    if (!account.enabled) throw new Error('Scheduled messages are unavailable in this channel.');
    const tokens = m.uploads ?? [];
    if (tokens.length && !this.uploads) throw new Error('Uploads are not taken here.');
    const held = this.uploads?.take(m.channelId, tokens) ?? [];
    const small = await uploadFiles(this.api, m.channelId, m.files.map((f) => ({ ...f, bytes: Buffer.from(f.bytes) })));
    const attachments = [...held, ...small.map((f, i) => ({ ...f, id: String(held.length + i) }))];
    let attempted = false;
    try {
      const item = await this.api.postOnce<ScheduledMessage>(PATH, {
        channel_id: m.channelId, ...scheduledContent(m.text), scheduled_timestamp: m.scheduledTimestamp,
        allowed_mentions: typedMentions(m.replyTo?.ping ?? false), attachments,
        ...(m.replyTo ? { message_reference: { channel_id: m.channelId, message_id: m.replyTo.messageId } } : {}),
        ...(m.stickerId ? { sticker_ids: [m.stickerId] } : {}), ...(m.poll ? { poll: pollPayload(m.poll) } : {}),
      }, { guard: async () => { checkTime(m.scheduledTimestamp, m.replyTo?.messageId); await this.guard(account.userId, m.channelId); attempted = true; } });
      this.uploads?.release(tokens);
      return item;
    } catch (error) {
      if (error instanceof DiscordHttpError && error.code === SCHEDULE_LIMIT_CODE) throw new Error(`Scheduled message limit reached (${account.limit}).`);
      if (attempted && !isPostingLocked(error) && (!(error instanceof DiscordHttpError) || error.status >= 500)) throw new Error(SCHEDULE_UNCONFIRMED);
      throw error;
    }
  }

  async update(value: unknown): Promise<ScheduledMessage> {
    const u = checkScheduledUpdate(value);
    const item = (await this.list()).find((m) => m.scheduled_message_id === u.id);
    if (!item) throw new Error('This scheduled message is no longer pending. Refresh the list.');
    const replyId = item.create_args.message_reference?.message_id;
    checkScheduledUpdate(value, replyId);
    const content: Partial<{ content: string; flags: number }> = u.content === undefined
      ? u.flags === undefined ? {} : { flags: u.flags }
      : scheduledContent(u.content, (u.flags ?? item.create_args.flags) & ~SUPPRESS_NOTIFICATIONS);
    if (u.content !== undefined && !content.content?.trim() && !item.attachment_uploads?.length && !item.message_preview?.sticker_items?.length && !item.message_preview?.poll) throw new Error('Write a message first.');
    return this.api.patch<ScheduledMessage>(itemPath(u.id), {
      ...(u.scheduledTimestamp === undefined ? {} : { scheduled_timestamp: u.scheduledTimestamp }), ...content,
    }, { guard: async () => { if (u.scheduledTimestamp) checkTime(u.scheduledTimestamp, replyId); await this.guard(item.user_id); } });
  }

  async remove(id: unknown, sendNow = false): Promise<void> {
    const path = itemPath(id);
    const item = (await this.list()).find((m) => m.scheduled_message_id === id);
    if (!item) throw new Error('This scheduled message is no longer pending. Refresh the list.');
    const opts = { guard: () => this.guard(item.user_id) };
    if (sendNow) await this.api.postOnce(`${path}/send`, undefined, opts);
    else await this.api.delete(path, opts);
  }
}
