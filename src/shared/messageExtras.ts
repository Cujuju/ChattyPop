import type { ArchiveEmbed, ArchiveInteraction, ArchiveReaction, ArchiveSticker, AuthorStyle } from '@shared/contract';
import type { RawDisplayNameStyles } from '@shared/discord';
import { NAME_FONTS } from '@shared/nameFonts';
import { mediaSize } from '@shared/media';

/** Discord message type for a reply (message_reference then points at the replied-to message). */
export const REPLY_MESSAGE_TYPE = 19;

interface RawEmbed {
  type?: string;
  url?: string;
  title?: string;
  description?: string;
  color?: number;
  provider?: { name?: string };
  author?: { name?: string; url?: string; proxy_icon_url?: string };
  thumbnail?: RawEmbedMedia;
  image?: RawEmbedMedia;
  video?: RawEmbedMedia;
  footer?: { text?: string };
}

interface RawEmbedMedia {
  proxy_url?: string;
  width?: number;
  height?: number;
  /** EMBED_MEDIA_FLAG bits. */
  flags?: number;
}

/** Discord's embed media flags this app reads. */
const EMBED_MEDIA_FLAG = { animated: 1 << 5 } as const;
const isAnimated = (m: RawEmbedMedia | undefined): boolean => ((m?.flags ?? 0) & EMBED_MEDIA_FLAG.animated) !== 0;

const parse = <T>(json: string | null): T[] => {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** A JSON column's value; null when absent or malformed. */
export function parseJson(json: string | null): unknown {
  try {
    return json ? (JSON.parse(json) as unknown) : null;
  } catch {
    return null;
  }
}

/** The Nitro name font in a stored display-name style (users.name_style); null for the default face. */
export const nameFontFrom = (styleJson: string | null): AuthorStyle['font'] =>
  NAME_FONTS[(parseJson(styleJson) as RawDisplayNameStyles | null)?.font_id ?? 0] ?? null;

/** A user's stored server tag (users.tag_guild_id, tag, tag_badge); null for none. */
export const serverTagFrom = (guildId: string | null, text: string | null, badge: string | null): AuthorStyle['tag'] =>
  text && guildId ? { guildId, text, badge } : null;

/** Discord's interaction type for a slash command. */
const COMMAND_INTERACTION = 2;

interface RawInteraction {
  type?: number;
  name?: string;
  user?: { id: string; username: string; global_name?: string | null };
}

/** Who ran which command, on an app's reply to it: `interaction_metadata`, else the older `interaction` Discord still sends. */
export function interactionFrom(metaJson: string | null, legacyJson: string | null): ArchiveInteraction | null {
  const meta = parseJson(metaJson) as RawInteraction | null;
  const legacy = parseJson(legacyJson) as RawInteraction | null;
  const i = meta ?? legacy;
  if (!i?.user || i.type !== COMMAND_INTERACTION) return null;
  return { userId: i.user.id, userName: i.user.global_name ?? i.user.username, command: i.name ?? legacy?.name ?? null };
}

export function reactionsFrom(json: string | null): ArchiveReaction[] {
  return parse<{ emoji?: { id?: string | null; name?: string | null; animated?: boolean }; count?: number; me?: boolean }>(json)
    .filter((r) => r.emoji?.name && (r.count ?? 0) > 0)
    .map((r) => ({ emoji: { id: r.emoji!.id ?? null, name: r.emoji!.name!, animated: Boolean(r.emoji!.animated) }, count: r.count!, me: r.me === true }));
}

/** Only kinds Discord renders as a card or media; poll results and components have their own UI. */
const RENDERED_EMBED_TYPES = new Set(['rich', 'link', 'article', 'image', 'video', 'gifv']);

/** Images Discord draws in one embed's gallery; it ignores any past these. */
export const EMBED_GALLERY_MAX = 4;

/** Combines same-URL embeds into one card: first embed supplies text, later embeds contribute images. */
export function embedsFrom(json: string | null): ArchiveEmbed[] {
  const embeds: ArchiveEmbed[] = [];
  const byUrl = new Map<string, ArchiveEmbed>();
  for (const e of parse<RawEmbed>(json)) {
    if (!RENDERED_EMBED_TYPES.has(e.type ?? 'rich')) continue;
    const card = e.url ? byUrl.get(e.url) : undefined;
    if (card) {
      addGalleryImage(card, e.image);
      continue;
    }
    const embed: ArchiveEmbed = {
      type: e.type ?? 'rich',
      url: e.url ?? null,
      title: e.title ?? null,
      description: e.description ?? null,
      color: e.color ?? null,
      provider: e.provider?.name ?? null,
      author: e.author?.name ? { name: e.author.name, url: e.author.url ?? null, iconUrl: e.author.proxy_icon_url ?? null } : null,
      thumbnailUrl: e.thumbnail?.proxy_url ?? null,
      thumbnailSize: mediaSize(e.thumbnail),
      imageUrl: e.image?.proxy_url ?? null,
      imageSize: mediaSize(e.image),
      imageAnimated: isAnimated(e.image),
      // Only a proxied file plays here; a player page (YouTube's video.url) has no proxy_url. Embed fixers (fxTwitter,
      // fxTikTok) send their video on a rich embed.
      videoUrl: e.video?.proxy_url ?? null,
      videoSize: mediaSize(e.video),
      footer: e.footer?.text ?? null,
      notes: [],
    };
    embeds.push(embed);
    if (e.url) byUrl.set(e.url, embed);
  }
  return embeds;
}

/** A later same-URL embed's image joins the card: its own image when it had none, else the gallery, up to Discord's limit. */
function addGalleryImage(card: ArchiveEmbed, image: RawEmbedMedia | undefined): void {
  if (!image?.proxy_url) return;
  if (!card.imageUrl) {
    card.imageUrl = image.proxy_url;
    card.imageSize = mediaSize(image);
    card.imageAnimated = isAnimated(image);
  } else if (1 + (card.moreImages?.length ?? 0) < EMBED_GALLERY_MAX) {
    (card.moreImages ??= []).push({ url: image.proxy_url, size: mediaSize(image), animated: isAnimated(image) });
  }
}

/** Ids of the users Discord says the message pinged: @mentions, and a reply's author when the reply pings. */
export const mentionIdsFrom = (json: string | null): string[] => parse<{ id: string }>(json).map((u) => u.id);

export function mentionsFrom(json: string | null): Record<string, string> {
  return Object.fromEntries(parse<{ id: string; username: string; global_name?: string | null }>(json).map((u) => [u.id, u.global_name ?? u.username]));
}

export function stickersFrom(json: string | null): ArchiveSticker[] {
  return parse<{ id: string; name: string; format_type: number }>(json).map((s) => ({ id: s.id, name: s.name, formatType: s.format_type }));
}

