import { For, Match, Show, Switch, createSignal } from 'solid-js';
import type { ArchiveAttachment, AttachmentNote, MediaSize } from '@shared/contract';
import { attachmentUrl, attachmentView } from '@shared/media';
import { BYTES_PER_KB } from '@shared/units';
import { pluginPresents } from '@/state/plugins';
import { setLightbox } from '@/state/ui';
import { Icon } from '@/ui/icons';
import { mediaSizeVars } from './MessageExtras';
import { presentedParts } from './ownedParts';
import styles from './Attachment.module.css';

/**
 * An archived attachment: inline image, video or audio player when stored locally, otherwise a file chip with its download
 * status. Under stored media, one line holds its archived check and plugins' notes (a transcript); under a chip, the notes
 * (kept after the file is pruned). A video plays in place: a download link would take the phone app away from the page.
 * A video this browser can't decode falls back to the chip. A file not held locally links to its message on Discord.
 */
export function Attachment(props: { attachment: ArchiveAttachment; messageLink: string }) {
  const a = () => props.attachment;
  const stored = () => a().status === 'stored';
  const [unplayable, setUnplayable] = createSignal(false);
  const view = () => (unplayable() ? 'file' : attachmentView(a()));
  const notes = () => presentedParts(a().notes, pluginPresents);
  const src = () => (a().sha256 ? attachmentUrl(a().sha256!, a().filename) : undefined);
  const size = (): MediaSize | null => (a().width && a().height ? { width: a().width!, height: a().height! } : null);
  /** Viewer caption: name, pixel size and file size. */
  const sizeCaption = (): string =>
    [a().filename, a().width && a().height ? `${a().width}×${a().height}` : null, a().size ? `${Math.round(a().size! / BYTES_PER_KB)} KB` : null].filter(Boolean).join(' · ');
  const statusLabel = () =>
    ({ stored: 'archived locally', pending: 'downloading', failed: 'download failed', evicted: 'pruned by storage limit' })[a().status];
  return (
    <>
      <Show
        when={view() !== 'file'}
        fallback={
          <>
            <a class={styles.file} data-status={a().status} href={stored() ? src() : props.messageLink} download={stored() ? a().filename : undefined} target={stored() ? undefined : '_blank'}>
              <span class={styles.fileName}>{a().filename}</span>
              <span class={styles.fileMeta}>
                {a().size ? `${Math.round(a().size! / BYTES_PER_KB)} KB · ` : ''}
                {statusLabel()}
              </span>
            </a>
            <For each={notes()}>{(n) => <Note note={n} />}</For>
          </>
        }
      >
        <figure class={styles.image}>
          <Switch>
            <Match when={view() === 'image'}>
              <button type="button" class={styles.imageButton} aria-label={`Open ${a().filename}`} onClick={() => setLightbox({ src: src()!, alt: a().filename, caption: sizeCaption(), originalUrl: null })}>
                <img src={src()} alt={a().filename} data-sized={size() !== null} style={mediaSizeVars(size())} loading="lazy" />
              </button>
            </Match>
            <Match when={view() === 'video'}>
              <video src={src()} data-sized={size() !== null} style={mediaSizeVars(size())} controls playsinline preload="none" aria-label={`Play ${a().filename}`} onError={() => setUnplayable(true)} />
            </Match>
            <Match when={view() === 'audio'}>
              {/* Metadata, not "none": without it the player shows 00:00 until played. Ogg's length sits in its last page. */}
              <audio class={styles.audio} controls preload="metadata" src={src()} aria-label={`Play ${a().filename}`} />
            </Match>
          </Switch>
          {/* Discord names pasted media generically (image.png, voice-message.ogg), so no filename; inline media is always stored. */}
          <figcaption class={styles.status}>
            <span class={styles.stored} role="img" aria-label={statusLabel()} title={statusLabel()}>
              <Icon name="check" />
            </span>
            <For each={notes()}>{(n) => <Note note={n} />}</For>
          </figcaption>
        </figure>
      </Show>
    </>
  );
}

/**
 * A plugin's note under a file or embed (a transcript): one label line in every state, so a note that fills in or grows
 * never resizes its row. A click or tap anywhere on it shows or hides its text; the button's click bubbles here too.
 * data-note-part and data-note-plugin let the message menu find it (state/messageActions.ts).
 */
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
        <span class={styles.noteLabel}>{n().label}</span>
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
