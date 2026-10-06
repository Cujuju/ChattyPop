// The Archive composer's reply: which message is being answered, and Discord's @ON/@OFF choice (sent by composer.ts).
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { archiveChannelId, openArchive } from './archive';
import { onAppEvent } from './events';
import { inPanelWindow } from './ui';

const [replyTarget, setReplyTarget] = createSignal<ArchiveMessage | null>(null);
/** Kept across replies this session, so the owner's choice sticks. */
const [replyPing, setReplyPing] = createSignal(true);

export { replyTarget, replyPing, setReplyPing };

/** Discord refuses a reply to a deleted message. */
export const canReply = (m: ArchiveMessage): boolean => m.deletedAt === null;

/** Replies use Archive composer. Other panels navigate first; panel windows forward requests to main. */
export const startReply = (m: ArchiveMessage): void => {
  if (inPanelWindow) return api.showInMainWindow(m.channelId, m.id, { compose: 'reply' });
  if (archiveChannelId() !== m.channelId) void openArchive(m.channelId, m.id);
  setReplyTarget(m);
};
export const cancelReply = (): void => {
  setReplyTarget(null);
};
/** A message that came back unsent answers `m` again, unless another reply has started since. */
export const restoreReply = (m: ArchiveMessage): void => {
  if (!replyTarget()) setReplyTarget(m);
};

/** A panel window's Reply, handed over: the Archive shows the message (alerts.ts), and the composer opens on it. */
onAppEvent('open-message', async (e) => {
  if (e.compose !== 'reply' || !e.messageId) return;
  const m = await api.core.messageById(e.messageId);
  if (m) startReply(m);
});
