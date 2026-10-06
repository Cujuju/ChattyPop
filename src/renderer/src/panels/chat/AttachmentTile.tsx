// One attachment's frame in the log: its spoiler cover, its removed mark and the bar Discord shows at its top-right on hover.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { HOST_ATTACHMENT_ACTIONS } from '@shared/anchors';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import type { AttachmentBarView, HostAttachmentAction } from '@/plugins/messageSlots';
import { attachmentActionItems } from '@/plugins/slots';
import { canSave, saveAttachment } from '@/state/savedFiles';
import { inCompanion } from '@/state/ui';
import { SolidIcon } from '@/ui/solidIcons';
import { HoverBarButton } from './HoverBarButton';
import styles from './Attachment.module.css';

/** Download: saves the archived file where the owner picks; nothing while the file isn't held here. */
const Download: AttachmentBarView['Component'] = (props) => (
  <Show when={canSave(props.attachment)}>
    <HoverBarButton label="Download" icon={(c) => <SolidIcon name="download" class={c} />} onClick={() => void saveAttachment(props.attachment)} />
  </Show>
);

/** The host's bar items: empty anchors where a posting plugin places Modify and Delete, then Download. */
const HOST_ITEMS: readonly HostAttachmentAction[] = HOST_ATTACHMENT_ACTIONS.map((id) => ({ id, Component: id === 'download' ? Download : () => null }));

const px = (v: string): number => parseFloat(v) || 0;

/** Measures single-row bar width including buttons, gaps, padding, borders and both tile-edge insets. */
function rowWidth(bar: HTMLElement): number {
  const s = getComputedStyle(bar);
  const buttons = [...bar.children] as HTMLElement[];
  const gaps = px(s.columnGap) * Math.max(0, buttons.length - 1);
  const box = px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
  return buttons.reduce((w, b) => w + b.offsetWidth, 0) + gaps + box + 2 * px(s.right);
}

/** Desktop attachment hover bars show plugin actions then Download. Narrow tiles use one column; bars never wrap or appear on phone. */
function AttachmentBar(props: { message: ArchiveMessage; attachment: ArchiveAttachment }) {
  let bar!: HTMLDivElement;
  const [stacked, setStacked] = createSignal(false);
  onMount(() => {
    const tile = bar.parentElement!;
    // The tile resizes with the log; the bar with the buttons its message offers.
    const fit = new ResizeObserver(() => setStacked(rowWidth(bar) > tile.clientWidth));
    fit.observe(tile);
    fit.observe(bar);
    onCleanup(() => fit.disconnect());
  });
  return (
    <div ref={bar} class={`cp-stroke ${styles.bar}`} data-stacked={stacked()} role="toolbar" aria-label="Attachment actions">
      <For each={attachmentActionItems(HOST_ITEMS)}>{(item) => <item.Component message={props.message} attachment={props.attachment} />}</For>
    </div>
  );
}

/** An attachment's frame: covered while it is a spoiler not yet revealed, marked once removed from its message. */
export function AttachmentTile(props: { message: ArchiveMessage; attachment: ArchiveAttachment; children: JSX.Element }) {
  const [revealed, setRevealed] = createSignal(false);
  const covered = () => props.attachment.spoiler && !revealed();
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
      <Show when={!inCompanion}>
        <AttachmentBar message={props.message} attachment={props.attachment} />
      </Show>
    </div>
  );
}
