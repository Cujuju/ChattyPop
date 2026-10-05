// A message's attachments as Discord lays them out: two or more images and videos share one mosaic; a lone one keeps its
// own size; audio and other files follow, one per line.
import { For, Show, createSignal } from 'solid-js';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import { pluginPresents } from '@/state/plugins';
import { Attachment, AttachmentMedia, FileChip, StoredStatus } from './Attachment';
import { AttachmentTile } from './AttachmentTile';
import { inMosaic, mosaicRows } from './mosaic';
import { presentedParts } from './ownedParts';
import styles from './Attachment.module.css';

export function Attachments(props: { message: ArchiveMessage; messageLink: string }) {
  const media = () => props.message.attachments.filter(inMosaic);
  const others = () => props.message.attachments.filter((a) => !inMosaic(a));
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

/**
 * Images and videos in one grid of cropped cells (mosaic.ts), rows marked with their tile count and the whole with its
 * total, for the stylesheet. One line under it holds the archived check and every tile's notes, in tile order.
 */
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
      <StoredStatus notes={notes()} />
    </figure>
  );
}

/** One cell: the picture or video, cropped to it; a video this browser can't decode shows as its file chip. */
function MosaicTile(props: { message: ArchiveMessage; attachment: ArchiveAttachment; messageLink: string }) {
  const [unplayable, setUnplayable] = createSignal(false);
  return (
    <AttachmentTile message={props.message} attachment={props.attachment}>
      <Show when={!unplayable()} fallback={<FileChip attachment={props.attachment} messageLink={props.messageLink} />}>
        <AttachmentMedia attachment={props.attachment} cell onUnplayable={() => setUnplayable(true)} />
      </Show>
    </AttachmentTile>
  );
}
