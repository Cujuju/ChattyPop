// One attachment's frame in the log: its spoiler cover, its removed mark and the bar Discord shows at its top-right on hover.
import { For, Show, createSignal, type JSX } from 'solid-js';
import { HOST_ATTACHMENT_ACTIONS } from '@shared/anchors';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import { attachmentUrl, isSpoilerName } from '@shared/media';
import type { AttachmentBarView, HostAttachmentAction } from '@/plugins/messageSlots';
import { attachmentActionItems } from '@/plugins/slots';
import { inCompanion } from '@/state/ui';
import { SolidIcon } from '@/ui/solidIcons';
import { HoverBarButton } from './HoverBarButton';
import styles from './Attachment.module.css';

/** Download: the archived file under its own name; nothing while the file isn't held here. */
const Download: AttachmentBarView['Component'] = (props) => {
  const save = (): void => {
    const link = document.createElement('a');
    link.href = attachmentUrl(props.attachment.sha256!, props.attachment.filename);
    link.download = props.attachment.filename;
    link.click();
  };
  return (
    <Show when={props.attachment.status === 'stored' && props.attachment.sha256}>
      <HoverBarButton label="Download" icon={(c) => <SolidIcon name="download" class={c} />} onClick={save} />
    </Show>
  );
};

/** The host's bar items: empty anchors where a posting plugin places Modify and Delete, then Download. */
const HOST_ITEMS: readonly HostAttachmentAction[] = HOST_ATTACHMENT_ACTIONS.map((id) => ({ id, Component: id === 'download' ? Download : () => null }));

/**
 * The bar over a hovered attachment: plugins' actions (a posting plugin's Modify and Delete), then Download. The
 * stylesheet shows it while the tile is hovered or holds focus. Never on the phone, which has no hover.
 */
function AttachmentBar(props: { message: ArchiveMessage; attachment: ArchiveAttachment }) {
  return (
    <Show when={!inCompanion}>
      <div class={`cp-stroke ${styles.bar}`} role="toolbar" aria-label="Attachment actions">
        <For each={attachmentActionItems(HOST_ITEMS)}>{(item) => <item.Component message={props.message} attachment={props.attachment} />}</For>
      </div>
    </Show>
  );
}

/** An attachment's frame: covered while it is a spoiler not yet revealed, marked once removed from its message. */
export function AttachmentTile(props: { message: ArchiveMessage; attachment: ArchiveAttachment; children: JSX.Element }) {
  const [revealed, setRevealed] = createSignal(false);
  const covered = () => isSpoilerName(props.attachment.filename) && !revealed();
  return (
    <div class={styles.tile} data-covered={covered()} data-removed={props.attachment.removed}>
      {props.children}
      <Show when={covered()}>
        <button type="button" class={styles.spoiler} aria-label={`Spoiler: show ${props.attachment.filename}`} onClick={() => setRevealed(true)}>
          Spoiler
        </button>
      </Show>
      <Show when={props.attachment.removed}>
        <span class={styles.removed} title="Removed from its message on Discord; kept in the archive">
          Removed
        </span>
      </Show>
      <AttachmentBar message={props.message} attachment={props.attachment} />
    </div>
  );
}
