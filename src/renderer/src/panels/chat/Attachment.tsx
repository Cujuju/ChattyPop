import { For, Match, Show, Switch, createSignal } from 'solid-js';
import type { ArchiveAttachment, ArchiveMessage, AttachmentNote, MediaSize } from '@shared/contract';
import { attachmentUrl, attachmentView } from '@shared/media';
import { BYTES_PER_KB } from '@shared/units';
import { pluginPresents } from '@/state/plugins';
import { canSave, saveAttachment, savesThroughMain } from '@/state/savedFiles';
import { setLightbox } from '@/state/ui';
import { Icon } from '@/ui/icons';
import { AttachmentTile } from './AttachmentTile';
import { mediaSizeVars } from './MessageExtras';
import { presentedParts } from './ownedParts';
import styles from './Attachment.module.css';

const STATUS_LABEL: Readonly<Record<ArchiveAttachment['status'], string>> = {
  stored: 'archived locally',
  pending: 'downloading',
  failed: 'download failed',
  evicted: 'pruned by storage limit',
};

const src = (a: ArchiveAttachment): string | undefined => (a.sha256 ? attachmentUrl(a.sha256, a.filename) : undefined);
const kilobytes = (a: ArchiveAttachment): string => (a.size ? `${Math.round(a.size / BYTES_PER_KB)} KB` : '');

/** Shows stored media inline or file-status chips. Notes survive pruning; unsupported video decoders fall back to chips. */
export function Attachment(props: { message: ArchiveMessage; attachment: ArchiveAttachment; messageLink: string }) {
  const a = () => props.attachment;
  const [unplayable, setUnplayable] = createSignal(false);
  const view = () => (unplayable() ? 'file' : attachmentView(a()));
  const notes = () => presentedParts(a().notes, pluginPresents);
  return (
    <Show
      when={view() !== 'file'}
      fallback={
        <>
          <AttachmentTile message={props.message} attachment={a()}>
            <FileChip attachment={a()} messageLink={props.messageLink} />
          </AttachmentTile>
          <For each={notes()}>{(n) => <Note note={n} />}</For>
        </>
      }
    >
      <figure class={styles.image}>
        <AttachmentTile message={props.message} attachment={a()}>
          <AttachmentMedia attachment={a()} onUnplayable={() => setUnplayable(true)} />
        </AttachmentTile>
        <StoredStatus notes={notes()} />
      </figure>
    </Show>
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
          onClick={() => setLightbox({ src: src(a())!, alt: a().description ?? a().filename, caption: sizeCaption(), originalUrl: null })}
        >
          <img src={src(a())} alt={a().description ?? a().filename} data-sized={size() !== null} style={mediaSizeVars(size())} loading="lazy" />
        </button>
      </Match>
      <Match when={attachmentView(a()) === 'video'}>
        {/* Metadata, not "none": an attachment has no poster, so it shows its first frame. Only on-screen rows mount. */}
        <video
          src={src(a())}
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

/** File chips show name/size/status. Stored files save through desktop dialogs or phone downloads; missing files link to Discord messages. */
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
      <span class={styles.fileName}>{a().filename}</span>
      <span class={styles.fileMeta}>
        {kilobytes(a()) ? `${kilobytes(a())} · ` : ''}
        {STATUS_LABEL[a().status]}
      </span>
    </a>
  );
}

/** Under stored media, its archived check, then plugins' notes. Discord names pasted media generically (image.png), so no filename. */
export function StoredStatus(props: { notes: AttachmentNote[] }) {
  return (
    <figcaption class={styles.status}>
      <span class={styles.stored} role="img" aria-label={STATUS_LABEL.stored} title={STATUS_LABEL.stored}>
        <Icon name="check" />
      </span>
      <For each={props.notes}>{(n) => <Note note={n} />}</For>
    </figcaption>
  );
}

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
