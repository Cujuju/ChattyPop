// Multiple image/video attachments share mosaics; single media keeps intrinsic sizing. Audio/other files follow one per line.
import { For, Show, createSignal } from 'solid-js';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import { pluginPresents } from '@/state/plugins';
import { uploadShownInline } from '@shared/chatSettings';
import { attachmentView } from '@shared/media';
import { discordChatSettings } from '@/state/chatSettings';
import { Attachment, AttachmentMedia, FileChip, MediaCaption, shownDescriptions } from './Attachment';
import { AttachmentTile } from './AttachmentTile';
import { inMosaic, mosaicRows } from './mosaic';
import { presentedParts } from './ownedParts';
import styles from './Attachment.module.css';

export function Attachments(props: { message: ArchiveMessage; messageLink: string }) {
  // Inline uploads off (Discord's "When uploaded directly to Discord"): images and videos are their chips.
  const media = () => props.message.attachments.filter((a) => inMosaic(a) && uploadShownInline(attachmentView(a), discordChatSettings()));
  const others = () => props.message.attachments.filter((a) => !media().includes(a));
  const one = (a: ArchiveAttachment) => <Attachment message={props.message} attachment={a} messageLink={props.messageLink} />;
  return (
    <>
      <Show when={media().length > 1} fallback={<For each={media()}>{one}</For>}>
        <MediaMosaic message={props.message} attachments={media()} messageLink={props.messageLink} />
      </Show>
      <For each={others()}>{one}</For>
    </>
  );
}

/** Mosaic rows expose tile counts. One status line lists archive state and all tile notes in order. */
function MediaMosaic(props: { message: ArchiveMessage; attachments: ArchiveAttachment[]; messageLink: string }) {
  const rows = (): ArchiveAttachment[][] => {
    let at = 0;
    return mosaicRows(props.attachments.length).map((n) => props.attachments.slice(at, (at += n)));
  };
  const notes = () => props.attachments.flatMap((a) => presentedParts(a.notes, pluginPresents));
  return (
    <figure class={styles.mosaic}>
      <div class={styles.grid} data-count={props.attachments.length}>
        <For each={rows()}>
          {(row) => (
            <div class={styles.row} data-count={row.length}>
              <For each={row}>{(a) => <MosaicTile message={props.message} attachment={a} messageLink={props.messageLink} />}</For>
            </div>
          )}
        </For>
      </div>
      <MediaCaption notes={notes()} descriptions={shownDescriptions(props.attachments)} />
    </figure>
  );
}

/** One cell: the picture or video, cropped to it; a video this browser can't decode shows as its file chip. */
function MosaicTile(props: { message: ArchiveMessage; attachment: ArchiveAttachment; messageLink: string }) {
  const [unplayable, setUnplayable] = createSignal(false);
  return (
    <AttachmentTile message={props.message} attachment={props.attachment} stored={!unplayable()}>
      <Show when={!unplayable()} fallback={<FileChip attachment={props.attachment} messageLink={props.messageLink} />}>
        <AttachmentMedia attachment={props.attachment} cell onUnplayable={() => setUnplayable(true)} />
      </Show>
    </AttachmentTile>
  );
}
