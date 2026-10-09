// One attachment's frame in the log: its spoiler cover and its removed mark. Its actions (Download, a posting plugin's
// Modify and Delete) are in its message's menu, found by data-attachment-id (state/messageActions.ts).
import { Show, createSignal, useContext, type JSX } from 'solid-js';
import type { ArchiveAttachment } from '@shared/contract';
import { Icon } from '@/ui/icons';
import { SpoilersShown } from '@/ui/spoilers';
import styles from './Attachment.module.css';

/** The stored mark's label; a removed file's mark says it is kept instead. */
export const STORED_LABEL = 'archived locally';

/**
 * An attachment's frame: covered while it is a spoiler not yet revealed, marked once removed from its message. `stored`:
 * the file is held here, so its top-left corner carries the archived check (media, text or file card alike).
 */
export function AttachmentTile(props: { attachment: ArchiveAttachment; stored?: boolean; children: JSX.Element }) {
  const [revealed, setRevealed] = createSignal(false);
  const uncovered = useContext(SpoilersShown);
  const covered = () => props.attachment.spoiler && !revealed() && !uncovered();
  return (
    <div class={styles.tile} data-attachment-id={props.attachment.id} data-covered={covered()} data-removed={props.attachment.removed}>
      {props.children}
      <Show when={covered()}>
        <button type="button" class={styles.spoiler} aria-label={`Spoiler: show ${props.attachment.filename}`} onClick={() => setRevealed(true)}>
          Spoiler
        </button>
      </Show>
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
