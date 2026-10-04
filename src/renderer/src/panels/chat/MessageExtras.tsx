import { For, Show, type JSX } from 'solid-js';
import type { ArchiveEmbed, ArchiveMessage, ArchiveReply, ArchiveSticker, MediaSize } from '@shared/contract';
import { emojiUrl } from '@shared/emoji';
import { animatedMediaUrl, avatarUrl, proxiedUrl, thumbUrl } from '@shared/media';
import { openArchive } from '@/state/archive';
import { canReact, openReactionPicker, react } from '@/state/reactions';
import { setLightbox } from '@/state/ui';
import { InlineMarkdown, Markdown } from '@/ui/Markdown';
import { SolidIcon } from '@/ui/solidIcons';
import { StickerArt } from '@/ui/StickerArt';
import { ReactionTipAnchor } from './ReactionTip';
import { Note } from './Attachment';
import { presentedParts } from './ownedParts';
import { pluginPresents } from '@/state/plugins';
import styles from './Extras.module.css';

/** Replies show the first line of the replied-to text, cut to this length. */
const REPLY_PREVIEW_CHARS = 120;
const HEX_RADIX = 16;
const COLOR_DIGITS = 6;

/** A Discord 0xRRGGBB colour as CSS. */
export const hexColor = (n: number): string => `#${n.toString(HEX_RADIX).padStart(COLOR_DIGITS, '0')}`;

/** A media file's pixel size as CSS variables: with data-sized, the stylesheet reserves its box before it loads. */
export const mediaSizeVars = (s: MediaSize | null): JSX.CSSProperties => (s ? { '--media-w': s.width, '--media-h': s.height } : {});

/** The reply line above a reply: small avatar, name and the start of the replied-to message; click jumps to it.
 *  pinged: the reply pinged its author, so the name reads @name, as Discord shows it. */
export function ReplyLine(props: { reply: ArchiveReply; channelId: string; pinged: boolean }) {
  const preview = () => props.reply.content.split('\n')[0]!.slice(0, REPLY_PREVIEW_CHARS) || 'Click to see attachment';
  return (
    <button type="button" class={styles.reply} onClick={() => void openArchive(props.channelId, props.reply.messageId)} title="Jump to the replied-to message">
      <img data-avatar class={styles.replyAvatar} src={avatarUrl(props.reply.authorId, props.reply.avatar)} alt="" loading="lazy" />
      <span
        class={styles.replyName}
        data-role-color={props.reply.authorColor !== null}
        style={props.reply.authorColor !== null ? { '--role-color': hexColor(props.reply.authorColor) } : undefined}
      >
        {props.pinged ? '@' : ''}
        {props.reply.authorName}
      </span>
      <span class={styles.replyText}>
        {/* Inside the jump button: links stay text and spoilers stay shut, so a tap only jumps. */}
        <InlineMarkdown text={preview()} mentions={props.reply.mentions} inert />
      </span>
    </button>
  );
}

/** A message's reactions, as Discord shows them: a tap joins in (or takes the owner's back); + adds a new one. */
export function Reactions(props: { message: ArchiveMessage }) {
  const m = () => props.message;
  return (
    <Show when={m().reactions.length}>
      <div class={styles.reactions}>
        <For each={m().reactions}>
          {(r) => (
            <ReactionTipAnchor message={m()} reaction={r} class={styles.reactionAnchor}>
              {(consumeHold) => (
                <button
                  type="button"
                  class={styles.reaction}
                  data-me={r.me}
                  aria-pressed={r.me}
                  aria-label={`:${r.emoji.name}:, ${r.count}${r.me ? ', yours' : ''}`}
                  disabled={!canReact(m())}
                  onClick={() => consumeHold() || react(m(), r.emoji, !r.me)}
                >
                  <Show when={r.emoji.id} fallback={<span class={styles.reactionUnicode}>{r.emoji.name}</span>}>
                    {(id) => <img class={styles.reactionEmoji} src={emojiUrl({ id: id(), animated: r.emoji.animated })} alt={`:${r.emoji.name}:`} loading="lazy" />}
                  </Show>
                  <span class={styles.reactionCount}>{r.count}</span>
                </button>
              )}
            </ReactionTipAnchor>
          )}
        </For>
        <Show when={canReact(m())}>
          <button type="button" class={styles.addReaction} aria-label="Add reaction" title="Add reaction" onClick={(e) => openReactionPicker(m(), e.clientX, e.clientY)}>
            <SolidIcon name="addReaction" />
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function Stickers(props: { stickers: ArchiveSticker[] }) {
  return (
    <For each={props.stickers}>{(s) => <StickerArt sticker={s} class={styles.sticker} />}</For>
  );
}

/** GIF embeds, and bare image links, show just the media, as Discord does. */
export const isMediaOnly = (e: ArchiveEmbed): boolean => e.type === 'gifv' || (e.type === 'image' && !e.title && !e.description);

/** Discord hides a message's text when it is only the link its media-only embed shows. */
export const textIsEmbedLink = (content: string, embeds: ArchiveEmbed[]): boolean =>
  embeds.some((e) => isMediaOnly(e) && e.url !== null && e.url === content.trim());

/** `brief`: every card's description is clamped, a bot's too (a list of previews, where a card is one of many). */
export function Embeds(props: { embeds: ArchiveEmbed[]; mentions: Record<string, string>; brief?: boolean }) {
  return (
    <For each={props.embeds}>
      {(e) => (
        <Show
          when={!isMediaOnly(e)}
          fallback={
            <>
              <EmbedMedia embed={e} />
              <EmbedNotes embed={e} />
            </>
          }
        >
          <article
            class={styles.embed}
            style={e.color !== null ? { '--embed-color': hexColor(e.color) } : {}}
          >
            <div class={styles.embedBody}>
              <Show when={e.provider}>{(p) => <span class={styles.embedProvider}>{p()}</span>}</Show>
              <Show when={e.author}>
                {(a) => (
                  <span class={styles.embedAuthor}>
                    <Show when={a().iconUrl}>{(src) => <img class={styles.embedAuthorIcon} src={thumbUrl(src())} alt="" loading="lazy" />}</Show>
                    <Show when={a().url} fallback={a().name}>
                      {(href) => (
                        <a href={href()} target="_blank" rel="noreferrer">
                          {a().name}
                        </a>
                      )}
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={e.title}>
                {(t) => (
                  <Show when={e.url} fallback={<span class={styles.embedTitle}>{t()}</span>}>
                    {(href) => (
                      <a class={styles.embedTitle} data-link="true" href={href()} target="_blank" rel="noreferrer">
                        {t()}
                      </a>
                    )}
                  </Show>
                )}
              </Show>
              <Show when={e.description}>
                {(d) => (
                  <div class={styles.embedDescription} data-clamped={props.brief || e.type !== 'rich'}>
                    <Markdown text={d()} mentions={props.mentions} />
                  </div>
                )}
              </Show>
              <Show when={e.imageUrl || e.videoUrl || (LARGE_THUMB_TYPES.has(e.type) && e.thumbnailUrl)}>
                <EmbedMedia embed={e} />
              </Show>
              <Show when={e.footer}>{(f) => <span class={styles.embedFooter}>{f()}</span>}</Show>
              <EmbedNotes embed={e} />
            </div>
            <Show when={e.thumbnailUrl && !e.imageUrl && !e.videoUrl && !LARGE_THUMB_TYPES.has(e.type)}>
              <img class={styles.embedThumb} src={thumbUrl(e.thumbnailUrl!)} alt="" loading="lazy" />
            </Show>
          </article>
        </Show>
      )}
    </For>
  );
}

/** Plugins' notes on the embed's text and media (a transcript, a translation), as under an attachment. */
function EmbedNotes(props: { embed: ArchiveEmbed }) {
  return <For each={presentedParts(props.embed.notes ?? [], pluginPresents)}>{(n) => <Note note={n} />}</For>;
}

/** Embeds whose thumbnail is their media, drawn large as Discord does (a video's still, a linked image), not beside the text. */
const LARGE_THUMB_TYPES = new Set(['video', 'image']);

/**
 * The embed's large media: a looping muted video for GIF-style embeds, a player for other videos (fetched on play, not
 * while scrolling), else the image (or thumbnail).
 */
function EmbedMedia(props: { embed: ArchiveEmbed }) {
  const e = () => props.embed;
  const still = () => e().imageUrl ?? e().thumbnailUrl;
  const stillSize = () => (e().imageUrl ? e().imageSize : e().thumbnailSize);
  const videoSize = () => e().videoSize ?? stillSize();
  const poster = () => (still() ? thumbUrl(still()!) : undefined);
  const stillOrGallery = () => (
    <Show when={e().imageUrl && e().moreImages?.length} fallback={<EmbedImage embed={e()} still={still()} size={stillSize()} />}>
      <EmbedGallery embed={e()} />
    </Show>
  );
  return (
    <Show
      when={e().type === 'gifv' && e().videoUrl}
      fallback={
        <Show when={e().videoUrl} fallback={stillOrGallery()}>
          {(src) => <video class={styles.embedImage} data-sized={videoSize() !== null} style={mediaSizeVars(videoSize())} src={proxiedUrl(src())} poster={poster()} controls playsinline preload="none" />}
        </Show>
      }
    >
      {(src) => <video class={styles.embedImage} data-sized={videoSize() !== null} style={mediaSizeVars(videoSize())} src={proxiedUrl(src())} poster={poster()} autoplay loop muted playsinline />}
    </Show>
  );
}

/**
 * A multi-photo embed's images in one box, each cropped to its cell as Discord's gallery crops them; each opens in the
 * lightbox at full size.
 */
function EmbedGallery(props: { embed: ArchiveEmbed }) {
  const e = () => props.embed;
  const images = (): string[] => [e().imageUrl!, ...(e().moreImages ?? []).map((i) => i.url)];
  return (
    <div class={styles.embedGallery} data-count={images().length}>
      <For each={images()}>
        {(url) => (
          <button
            type="button"
            class={styles.embedGalleryItem}
            aria-label="Open image"
            onClick={() => setLightbox({ src: proxiedUrl(animatedMediaUrl(url)), alt: e().title ?? '', caption: e().title ?? e().provider ?? 'Image', originalUrl: e().url })}
          >
            <img class={styles.embedGalleryImage} src={thumbUrl(animatedMediaUrl(url))} alt="" loading="lazy" />
          </button>
        )}
      </For>
    </div>
  );
}

/** The embed's image, animated if it is (an embed fixer's GIF); opens in the lightbox at full size. */
function EmbedImage(props: { embed: ArchiveEmbed; still: string | null; size: MediaSize | null }) {
  const e = () => props.embed;
  return (
    <Show when={props.still && animatedMediaUrl(props.still)}>
      {(src) => (
        <button
          type="button"
          class={styles.embedImageButton}
          aria-label="Open image"
          onClick={() => setLightbox({ src: proxiedUrl(src()), alt: e().title ?? '', caption: e().title ?? e().provider ?? 'Image', originalUrl: e().url })}
        >
          <img class={styles.embedImage} data-sized={props.size !== null} style={mediaSizeVars(props.size)} src={thumbUrl(src())} alt="" loading="lazy" />
        </button>
      )}
    </Show>
  );
}
