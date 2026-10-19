// Conversation view: which message's exchange the Conversation window shows, that exchange from core, and the owner's marks on it.
import { api } from '@/api';
import type { ConversationMark } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { createSignal } from 'solid-js';
import { onAppEvent, onArchiveChange, onMessagePartsChanged } from './events';
import { keyedResource } from './keyedResource';

export const [conversationFor, setConversationFor] = createSignal<string | null>(null);
/** Also show later root-channel non-members within reach; unlinked messages between shown members always show. */
export const [showNearby, setShowNearby] = createSignal(false);

/** A mark made in this window, kept so it can be undone after its row has left the conversation. */
export interface RecentMark {
  messageId: string;
  mark: ConversationMark;
  author: string;
  text: string;
}
const [recent, setRecent] = createSignal<readonly RecentMark[]>([]);
export const recentMarks = recent;
const [markFailure, setMarkFailure] = createSignal<string | null>(null);
/** Why the last mark or undo failed; null after one succeeds. */
export const conversationMarkFailure = markFailure;
/** Bumped when the window's context changes (another message, privacy): a mark answered after it doesn't touch the new one. */
let context = 0;

/** One primitive key per (message, nearby) pair: keyedResource compares sources with ===. */
const source = (): string | null => {
  const id = conversationFor();
  return id && JSON.stringify([id, showNearby()]);
};

export const conversation = keyedResource(source, (key) => {
  const [id, nearby] = JSON.parse(key) as [string, boolean];
  return api.core.conversation(id, { nearby });
});

/** Forgets this window's marks: their snippets belong to the conversation and privacy state they were made in. */
const resetMarks = (): void => {
  context++;
  setRecent([]);
  setMarkFailure(null);
};

export const openConversation = (messageId: string): void => {
  if (conversationFor() === messageId) return conversation.refetch();
  resetMarks();
  setShowNearby(false);
  setConversationFor(messageId);
};

export const closeConversation = (): void => {
  resetMarks();
  setConversationFor(null);
};

/** Marks a message in the shown conversation; null clears its mark (Undo). */
export async function markConversationMessage(m: Omit<RecentMark, 'mark'>, mark: ConversationMark | null): Promise<void> {
  const of = conversationFor();
  if (!of) return;
  const asked = context;
  try {
    await api.core.conversationMark(m.messageId, of, mark);
    if (asked !== context) return;
    setMarkFailure(null);
    setRecent((list) => [...(mark ? [{ ...m, mark }] : []), ...list.filter((r) => r.messageId !== m.messageId)]);
  } catch (err) {
    if (asked === context) setMarkFailure(errorMessage(err));
  }
  if (asked === context) conversation.refetch();
}

onAppEvent('privacy-changed', () => {
  resetMarks();
  if (conversationFor()) conversation.refetch();
});

onAppEvent('conversations-changed', (e) => {
  if (!conversationFor()) return;
  // Still loading: the read in flight may predate these links, so read again.
  const shown = conversation()?.messages;
  if (!shown || shown.some((m) => e.channelIds.includes(m.channelId))) conversation.refetch();
});

onArchiveChange({
  kinds: ['messages', 'edits', 'deletes', 'reactions', 'polls', 'attachments', 'links', 'names', 'plugin'],
  shown: () => conversationFor() !== null,
  scope: () => {
    const shown = conversation()?.messages;
    // Before the first answer, any channel could belong to this conversation.
    return shown ? { channelIds: [...new Set(shown.map((m) => m.channelId))] } : 'all';
  },
}, () => conversation.refetch());

onMessagePartsChanged((ids) => {
  if (!conversationFor()) return;
  const shown = conversation()?.messages;
  if (!ids || !shown || shown.some((m) => ids.includes(m.id))) conversation.refetch();
});
