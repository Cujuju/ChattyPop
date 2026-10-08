// Accepted Discord payloads use the archive's payload readers before its stored copy arrives.
import type { ArchiveAttachment, ArchiveMessage } from './types/archive';
import type { RawMember, RawMessage } from './discord';
import { VERIFIED_BOT_FLAG } from './discord';
import { componentsFrom } from './components';
import { isAnimatedImage, isSpoiler } from './media';
import { pollFrom, type RawPoll } from './polls';
import { REPLY_MESSAGE_TYPE, embedsFrom, interactionFrom, mentionIdsFrom, mentionsFrom, nameFontFrom, reactionsFrom, serverTagFrom, stickersFrom } from './messageExtras';

interface PostedAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
  description?: string;
  flags?: number;
}

/** An accepted message as the log draws it; local media and plugin annotations follow with ingestion. */
export function postedArchiveMessage(m: RawMessage, nonce: string): ArchiveMessage {
  const json = (value: unknown): string | null => value == null ? null : JSON.stringify(value);
  const member = m.member as RawMember | undefined;
  const tag = m.author.primary_guild;
  const ref = m.message_reference as { message_id?: string } | undefined;
  const replyToId = m.type === REPLY_MESSAGE_TYPE ? ref?.message_id ?? null : null;
  const replied = m.referenced_message as RawMessage | undefined;
  const attachments: ArchiveAttachment[] = ((m.attachments ?? []) as PostedAttachment[]).map((a) => ({
    id: a.id, filename: a.filename, contentType: a.content_type ?? null, size: a.size ?? null,
    width: a.width ?? null, height: a.height ?? null, description: a.description ?? null,
    sha256: null, status: 'pending', removed: false, notes: [],
    spoiler: isSpoiler({ ...a, flags: a.flags ?? null }),
    animated: isAnimatedImage({ ...a, flags: a.flags ?? null, contentType: a.content_type ?? null }),
  }));
  return {
    id: m.id, nonce, channelId: m.channel_id, ts: Date.parse(m.timestamp),
    editedTs: m.edited_timestamp ? Date.parse(m.edited_timestamp) : null,
    deletedAt: null, prunedAt: null, content: m.content,
    author: {
      id: m.author.id, name: member?.nick ?? m.author.global_name ?? m.author.username,
      username: m.author.username, avatar: m.author.avatar ?? null,
      color: null, gradient: null, roleIcon: null,
      font: nameFontFrom(json(m.author.display_name_styles)),
      decoration: m.author.avatar_decoration_data?.asset ?? null,
      tag: tag?.identity_enabled ? serverTagFrom(tag.identity_guild_id ?? null, tag.tag ?? null, tag.badge ?? null) : null,
      app: m.author.bot ? { verified: ((m.author.public_flags ?? 0) & VERIFIED_BOT_FLAG) !== 0 } : null,
    },
    replyToId,
    reply: replyToId && replied?.author ? {
      messageId: replyToId, authorId: replied.author.id, authorName: replied.author.global_name ?? replied.author.username,
      authorColor: null, avatar: replied.author.avatar ?? null, content: replied.content,
      mentions: mentionsFrom(json(replied.mentions)),
    } : null,
    reactions: reactionsFrom(json(m.reactions)), mentions: mentionsFrom(json(m.mentions)),
    mentionIds: mentionIdsFrom(json(m.mentions)), mentionsEveryone: m.mention_everyone === true,
    embeds: embedsFrom(json(m.embeds)), stickers: stickersFrom(json(m.sticker_items)),
    revisions: [], attachments, notes: [], annotations: [], labels: [],
    flags: typeof m.flags === 'number' ? m.flags : 0,
    applicationId: typeof m.application_id === 'string' ? m.application_id : null,
    components: componentsFrom(json(m.components)),
    interaction: interactionFrom(json(m.interaction_metadata), json(m.interaction)),
    poll: pollFrom(m.poll as RawPoll | undefined),
  };
}
