import { Show, createMemo } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { archiveChannelId, archiveDensity, archiveState, atNewest, focusMessageId } from '@/state/archive';
import { isSelected } from '@/state/messageSelection';
import { createOwnAuthor, editingId, isSelf } from '@/state/ownMessages';
import { outgoing, type Outgoing } from '@/state/outbox';
import { DayDivider, dayLabel } from '@/ui/DayDivider';
import { canGroupMessage, GROUP_GAP_MS } from '@/ui/messageGrouping';
import type { VirtualLog } from '@/ui/virtualLog';
import { VirtualRows } from '@/ui/VirtualRows';
import { MessageRow } from './MessageRow';
import { PendingRow } from './PendingRow';
import styles from './Archive.module.css';

/** A day divider names the message it heads. */
export type ArchiveRow =
  | { kind: 'day'; key: string; label: string; messageId: string }
  | { kind: 'msg'; key: string; message: ArchiveMessage; grouped: boolean }
  | { kind: 'pending'; key: string; outgoing: Outgoing; own: ArchiveMessage['author'] | null; grouped: boolean };

/** Archive messages, day dividers and pending sends in display order. */
export function createArchiveRows() {
  const ownAuthor = createOwnAuthor(archiveChannelId);
  return createMemo<ArchiveRow[]>(() => {
    const out: ArchiveRow[] = [];
    let lastDay = '';
    let prev: ArchiveMessage | undefined;
    for (const m of archiveState.items) {
      const label = dayLabel(m.ts);
      const newDay = label !== lastDay;
      if (newDay) out.push({ kind: 'day', key: `day-${m.id}`, label, messageId: m.id });
      lastDay = label;
      const grouped = !newDay && canGroupMessage(prev, m);
      out.push({ kind: 'msg', key: m.id, message: m, grouped });
      prev = m;
    }
    // The owner's messages on their way follow the newest, under the owner's group when it's the last one.
    const channelId = archiveChannelId();
    if (channelId && atNewest()) {
      // Use the newest archived own author, falling back to the channel's stored author.
      const own = [...archiveState.items].reverse().find((m) => isSelf(m.author.id))?.author ?? ownAuthor() ?? null;
      let grouped = prev !== undefined && isSelf(prev.author.id) && Date.now() - prev.ts < GROUP_GAP_MS;
      for (const o of outgoing(channelId)) {
        out.push({ kind: 'pending', key: `pending-${o.id}`, outgoing: o, own, grouped });
        grouped = true;
      }
    }
    return out;
  });
}

/** The Archive's virtual message rows share MessageRow with other windows. */
export function ArchiveRows(props: { log: VirtualLog<ArchiveRow> }) {
  return (
    <VirtualRows log={props.log} class={styles.canvas}>
      {(row) => (
        <Show
          when={row().kind !== 'pending'}
          fallback={
            <PendingRow
              outgoing={(row() as Extract<ArchiveRow, { kind: 'pending' }>).outgoing}
              own={(row() as Extract<ArchiveRow, { kind: 'pending' }>).own}
              grouped={(row() as Extract<ArchiveRow, { kind: 'pending' }>).grouped}
              channelId={archiveChannelId()!}
            />
          }
        >
          <Show
            when={row().kind === 'day'}
            fallback={
              <MessageRow
                message={(row() as Extract<ArchiveRow, { kind: 'msg' }>).message}
                grouped={(row() as Extract<ArchiveRow, { kind: 'msg' }>).grouped}
                density={archiveDensity()}
                focused={focusMessageId() === row().key}
                selected={isSelected(row().key)}
                editing={editingId() === row().key}
              />
            }
          >
            <DayDivider label={(row() as Extract<ArchiveRow, { kind: 'day' }>).label} />
          </Show>
        </Show>
      )}
    </VirtualRows>
  );
}
