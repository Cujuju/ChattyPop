import { For, Match, Show, Switch, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { ArchiveAttachment, ArchiveMessage, AttachmentNote, MediaSize } from '@shared/contract';
import { attachmentPosterUrl, attachmentUrl, attachmentView } from '@shared/media';
import { AnimatedImage } from '@/ui/AnimatedImage';
import { pluginPresents } from '@/state/plugins';
import { canSave, saveAttachment, savesThroughMain } from '@/state/savedFiles';
import { setLightbox } from '@/state/ui';
import { kilobytesText } from '@/ui/format';
import { Icon, type IconName } from '@/ui/icons';
import { look } from '@/theme/look';
import { shownImageDescription, uploadShownInline } from '@shared/chatSettings';
import { discordChatSettings } from '@/state/chatSettings';
import { fileKind, fileTypeLabel } from '@shared/fileKinds';
import { AttachmentTile } from './AttachmentTile';
import { FileIcon } from './FileIcon';
import { mediaSizeVars } from './MessageExtras';
import { TextAttachment } from './TextAttachment';
import { presentedParts } from './ownedParts';
import styles from './Attachment.module.css';

/** A file card's status while not held here; a held one carries the stored media's check instead. */
const STATUS_LABEL: Readonly<Record<Exclude<ArchiveAttachment['status'], 'stored'>, string>> = {
  pending: 'downloading',
  failed: 'download failed',
  evicted: 'pruned by storage limit',
};

const src = (a: ArchiveAttachment): string | undefined => (a.sha256 ? attachmentUrl(a.sha256, a.filename) : undefined);
/** An animated image's still while the owner can't look: Discord's proxy's first frame, kept once fetched. */
const still = (a: ArchiveAttachment): string | undefined => (a.animated ? attachmentPosterUrl(a.id) : undefined);
const kilobytes = (a: ArchiveAttachment): string => kilobytesText(a.size);
/** Under a file card's name: its type (the part an ellipsized name loses), size, and status unless held here. */
const fileMeta = (a: ArchiveAttachment): string =>
  [fileTypeLabel(a), kilobytes(a), a.status === 'stored' ? '' : STATUS_LABEL[a.status]].filter(Boolean).join(' · ');

/** Shows stored media or text inline, else file-status chips. Notes survive pruning; unplayable video and unreadable text fall back to chips. */
export function Attachment(props: { message: ArchiveMessage; attachment: ArchiveAttachment; messageLink: string }) {
  const a = () => props.attachment;
  const [unshowable, setUnshowable] = createSignal(false);
  const view = () => (unshowable() || !uploadShownInline(attachmentView(a()), discordChatSettings()) ? 'file' : attachmentView(a()));
  const notes = () => presentedParts(a().notes, pluginPresents);
  return (
    <Switch
      fallback={
        <MediaFigure>
          <AttachmentTile message={props.message} attachment={a()} stored>
            <AttachmentMedia attachment={a()} onUnplayable={() => setUnshowable(true)} />
          </AttachmentTile>
          <MediaCaption notes={notes()} descriptions={shownDescriptions([a()])} />
        </MediaFigure>
      }
    >
      <Match when={view() === 'file'}>
        <AttachmentTile message={props.message} attachment={a()} stored={a().status === 'stored'}>
          <FileChip attachment={a()} messageLink={props.messageLink} />
        </AttachmentTile>
        <For each={notes()}>{(n) => <Note note={n} />}</For>
      </Match>
      <Match when={view() === 'text'}>
        <AttachmentTile message={props.message} attachment={a()} stored>
          <TextAttachment attachment={a()} onUnreadable={() => setUnshowable(true)} />
        </AttachmentTile>
        <For each={notes()}>{(n) => <Note note={n} />}</For>
      </Match>
    </Switch>
  );
}

const px = (v: string): number => parseFloat(v) || 0;

/**
 * One media tile and its caption. data-beside: a note column (--cp-note-min-w) fits beside the tile in the row, so the
 * caption sits there; else it goes under the tile, at the tile's width.
 */
function MediaFigure(props: { children: JSX.Element }) {
  let figure!: HTMLElement;
  const [beside, setBeside] = createSignal(false);
  onMount(() => {
    const row = figure.parentElement!;
    const tile = figure.firstElementChild as HTMLElement;
    const fit = (): void => {
      const f = getComputedStyle(figure);
      const r = getComputedStyle(row);
      const room = row.clientWidth - px(r.paddingLeft) - px(r.paddingRight);
      setBeside(tile.offsetWidth + px(f.columnGap) + px(f.getPropertyValue('--cp-note-min-w')) <= room);
    };
    // The row resizes with the log; the tile once its media's size is known.
    const watch = new ResizeObserver(fit);
    watch.observe(row);
    watch.observe(tile);
    onCleanup(() => watch.disconnect());
  });
  return (
    <figure ref={figure} class={styles.image} data-beside={beside()}>
      {props.children}
    </figure>
  );
}

/** Stored video plays inline to keep phone navigation. cell crops media into mosaic bounds instead of intrinsic sizing. */
export function AttachmentMedia(props: { attachment: ArchiveAttachment; cell?: boolean; onUnplayable: () => void }) {
  const a = () => props.attachment;
  const size = (): MediaSize | null => (!props.cell && a().width && a().height ? { width: a().width!, height: a().height! } : null);
  /** Viewer caption: name, pixel size and file size. */
  const sizeCaption = (): string => [a().filename, a().width && a().height ? `${a().width}×${a().height}` : null, kilobytes(a()) || null].filter(Boolean).join(' · ');
  return (
    <Switch>
      <Match when={attachmentView(a()) === 'image'}>
        <button
          type="button"
          class={styles.imageButton}
          aria-label={`Open ${a().filename}`}
          onClick={() => setLightbox({ src: src(a())!, still: still(a()), alt: a().description ?? a().filename, caption: sizeCaption(), originalUrl: null })}
        >
          <AnimatedImage src={src(a())} still={still(a())} alt={a().description ?? a().filename} data-sized={size() !== null} style={mediaSizeVars(size())} loading="lazy" />
        </button>
      </Match>
      <Match when={attachmentView(a()) === 'video'}>
        {/* The proxy's still: iOS paints no frame before play, and a codec the desktop lacks paints none. Metadata, not
            "none": without a still it shows its first frame, where it can. Only on-screen rows mount. */}
        <video
          src={src(a())}
          poster={attachmentPosterUrl(a().id)}
          data-sized={size() !== null}
          style={mediaSizeVars(size())}
          controls
          playsinline
          preload="metadata"
          aria-label={`Play ${a().filename}`}
          onError={() => props.onUnplayable()}
        />
      </Match>
      <Match when={attachmentView(a()) === 'audio'}>
        {/* Metadata, not "none": without it the player shows 00:00 until played. Ogg's length sits in its last page. */}
        <audio class={styles.audio} controls preload="metadata" src={src(a())} aria-label={`Play ${a().filename}`} />
      </Match>
    </Switch>
  );
}

/** File cards show the type icon, name, size and status. Stored files save through desktop dialogs or phone downloads; missing files link to Discord messages. */
export function FileChip(props: { attachment: ArchiveAttachment; messageLink: string }) {
  const a = () => props.attachment;
  const stored = () => canSave(a());
  const save = (e: MouseEvent): void => {
    if (!stored() || !savesThroughMain) return;
    e.preventDefault();
    void saveAttachment(a());
  };
  return (
    <a
      class={styles.file}
      data-status={a().status}
      href={stored() ? src(a()) : props.messageLink}
      download={stored() ? a().filename : undefined}
      target={stored() ? undefined : '_blank'}
      onClick={save}
    >
      <FileIcon kind={fileKind(a())} />
      <span class={styles.fileText}>
        <span class={styles.fileName}>{a().filename}</span>
        <span class={styles.fileMeta}>{fileMeta(a())}</span>
      </span>
    </a>
  );
}

/** The images' descriptions (alt text) while Discord's "Show image descriptions" is on, in order. Reactive. */
export const shownDescriptions = (list: ArchiveAttachment[]): string[] =>
  list.flatMap((a) => shownImageDescription(attachmentView(a), a.description, discordChatSettings()) ?? []);

const TRANSLATION_KIND = 'translation';

/** A translation reads after the notes it may translate (a transcript); the rest keep plugin order. */
const translationsLast = (notes: AttachmentNote[]): AttachmentNote[] =>
  [...notes].sort((x, y) => Number(x.kind === TRANSLATION_KIND) - Number(y.kind === TRANSLATION_KIND));

/** Beside or under stored media: image descriptions while shown, then plugins' notes; nothing when neither. Discord names pasted media generically (image.png), so no filename. */
export function MediaCaption(props: { notes: AttachmentNote[]; descriptions?: string[] }) {
  return (
    <Show when={props.notes.length || props.descriptions?.length}>
      <figcaption class={styles.caption}>
        <For each={props.descriptions ?? []}>
          {(d) => (
            <span class={look.text} data-size="xs" data-tone="secondary">
              {d}
            </span>
          )}
        </For>
        <For each={translationsLast(props.notes)}>{(n) => <Note note={n} />}</For>
      </figcaption>
    </Show>
  );
}

/** Note kinds the published plugins emit, drawn as an icon (the label becomes its tooltip); any other kind shows its label. */
const NOTE_ICONS: Readonly<Record<string, IconName | undefined>> = {
  transcript: 'waveform',
  'image-text': 'text',
  [TRANSLATION_KIND]: 'translate',
};

/** Plugin note labels retain constant height. Clicking toggles text; data-note-part/plugin identify notes for message menus. */
export function Note(props: { note: AttachmentNote }) {
  const n = () => props.note;
  const [open, setOpen] = createSignal(false);
  let note!: HTMLDivElement;
  const toggle = (): void => {
    // A drag that selected text in it (desktop) ends in a click too: that keeps it open.
    const picked = window.getSelection();
    if (picked && !picked.isCollapsed && note.contains(picked.anchorNode)) return;
    setOpen(!open());
  };
  return (
    <div
      ref={note}
      class={styles.note}
      data-kind={n().kind}
      data-state={n().state}
      data-open={open()}
      data-note-part={n().part}
      data-note-plugin={n().pluginId}
      onClick={toggle}
    >
      <div class={styles.noteHead}>
        <Show when={NOTE_ICONS[n().kind]} fallback={<span class={styles.noteLabel}>{n().label}</span>}>
          {(icon) => (
            <span class={styles.noteIcon} role="img" aria-label={n().label} title={n().label}>
              <Icon name={icon()} />
            </span>
          )}
        </Show>
        <button type="button" class={styles.noteToggle} aria-expanded={open()}>
          {open() ? 'Hide' : 'Show'}
        </button>
      </div>
      <Show when={open()}>
        <p class={styles.noteText}>{n().text}</p>
      </Show>
    </div>
  );
}
