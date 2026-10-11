// One attachment's frame in the log: its spoiler cover and its removed mark. Its actions (Download, a posting plugin's
// Modify and Delete) are in its message's menu, found by data-attachment-id (state/messageActions.ts).
import { Show, createEffect, type JSX } from 'solid-js';
import type { ArchiveAttachment } from '@shared/contract';
import { attachmentSpoilerKey } from '@shared/localSpoilers';
import { Icon } from '@/ui/icons';
import { createSpoilerCover, LocalSpoilerBadge, localSpoilerTitle } from '@/ui/LocalSpoiler';
import styles from './Attachment.module.css';

/** The stored mark's label; a removed file's mark says it is kept instead. */
export const STORED_LABEL = 'archived locally';

/**
 * An attachment's frame: covered while it is a spoiler not yet revealed, marked once removed from its message. `stored`:
 * the file is held here, so its top-left corner carries the archived check (media, text or file card alike).
 */
export function AttachmentTile(props: { attachment: ArchiveAttachment; stored?: boolean; children: JSX.Element }) {
  const key = () => attachmentSpoilerKey(props.attachment.id);
  const cover = createSpoilerCover(key, () => props.attachment.spoiler);
  let tile!: HTMLDivElement;
  createEffect(() => {
    const covered = cover.covered();
    for (const child of tile.children) if (child instanceof HTMLElement && !child.hasAttribute('data-spoiler-control')) child.inert = covered;
    if (covered) tile.querySelectorAll<HTMLMediaElement>('audio, video').forEach((player) => player.pause());
  });
  return (
    <div ref={tile} class={styles.tile} data-attachment-id={props.attachment.id} data-local-spoiler-key={key()} data-sender-spoiler={props.attachment.spoiler} data-covered={cover.covered()} data-removed={props.attachment.removed}>
      {props.children}
      <Show when={cover.covered()}>
        <button type="button" data-spoiler-control class={styles.spoiler} aria-label={`${cover.local() ? 'Local spoiler' : 'Spoiler'}: show ${props.attachment.filename}`} title={cover.local() ? localSpoilerTitle(props.attachment.spoiler) : undefined} onClick={cover.reveal}>
          {cover.local() ? 'Local spoiler' : 'Spoiler'}
        </button>
      </Show>
      <Show when={cover.local()}><LocalSpoilerBadge senderSpoiler={props.attachment.spoiler} /></Show>
      <Show
        when={props.attachment.removed}
        fallback={
          <Show when={props.stored}>
            <span class={styles.storedMark} role="img" aria-label={STORED_LABEL} title={STORED_LABEL}>
              <Icon name="check" />
            </span>
          </Show>
        }
      >
        <span class={styles.removed} title="Removed from its message on Discord; kept in the archive">
          Removed
        </span>
      </Show>
    </div>
  );
}
