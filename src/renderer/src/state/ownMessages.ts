// The owner's own messages: editing one in place in the Archive (Discord's Edit: which message, its draft, saving it) and deleting one.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { archiveChannelId, archiveState, openArchive } from './archive';
import { chatSource } from './chat';
import { createPushedValue, onAppEvent } from './events';
import { closeWhenLocked, postingUnlocked } from './posting';
import { inPanelWindow } from './ui';

/** The signed-in Discord user's id; null until main has read it. */
const selfId = createPushedValue(
  () => api.core.selfId(),
  'self-changed',
  (e) => e.userId,
).value;

interface EditDraft {
  message: ArchiveMessage;
  text: string;
  /** One per Edit: a save finishing late clears only its own session, not a later edit of the same message. */
  session: number;
}
const [draft, setDraft] = createSignal<EditDraft | null>(null);
let sessions = 0;

/** The message being edited, or null. */
export const editingId = (): string | null => draft()?.message.id ?? null;
export const editText = (): string => draft()?.text ?? '';
/** The open edit's session, or null. */
export const editSession = (): number | null => draft()?.session ?? null;
export const setEditText = (text: string): void => void setDraft((d) => d && { ...d, text });

/** The owner's message, still on Discord (a deleted one is kept only in the archive). */
/** Discord highlights it for the owner: it pings them, by @mention, a pinging reply, or @everyone / @here. */
export const mentionsMe = (m: ArchiveMessage): boolean => m.mentionsEveryone || (selfId() !== null && m.mentionIds.includes(selfId()!));

/** The signed-in Discord user. */
export const isSelf = (userId: string): boolean => selfId() !== null && userId === selfId();
export const canDelete = (m: ArchiveMessage): boolean => isSelf(m.author.id) && m.deletedAt === null;
/** As canDelete, with its text still here to start from (text retention empties it). */
export const canEdit = (m: ArchiveMessage): boolean => canDelete(m) && m.prunedAt === null;

/** The message the delete dialog asks about (DeleteMessageDialog), or null while it is closed. */
const [deleting, setDeleting] = createSignal<ArchiveMessage | null>(null);
export const deletingMessage = deleting;
export const closeDeleteDialog = (): void => void setDeleting(null);
closeWhenLocked(() => deleting() !== null, closeDeleteDialog);

/** The menu's Delete: opens the dialog that asks first; never while posting is locked. */
export function deleteMessage(m: ArchiveMessage): void {
  if (postingUnlocked()) setDeleting(m);
}

/**
 * Deletes `m` from Discord; the archive keeps it, marked deleted, once Discord reports the deletion. Rejects with
 * Discord's reason.
 */
export async function confirmDelete(m: ArchiveMessage): Promise<void> {
  await api.discord.deleteMessage({ channelId: m.channelId, messageId: m.id });
  if (draft()?.message.id === m.id) setDraft(null);
}

/**
 * Opens the editor on `m` in its row. Another panel's Edit shows the message in the Archive first; a panel window has
 * no Archive and hands the edit to the main window.
 */
export function startEdit(m: ArchiveMessage): void {
  if (inPanelWindow) return api.showInMainWindow(m.channelId, m.id, { compose: 'edit' });
  // The editor is drawn in the message's row, so the Archive must show the channel with the message loaded.
  const shown = archiveChannelId() === m.channelId && chatSource() === 'archive' && archiveState.items.some((x) => x.id === m.id);
  if (!shown) void openArchive(m.channelId, m.id);
  setDraft({ message: m, text: m.content, session: ++sessions });
}

export const cancelEdit = (): void => void setDraft(null);

/** The owner's newest editable message loaded in the channel (Discord's Up arrow in an empty composer). */
export function lastEditable(channelId: string): ArchiveMessage | null {
  const items = archiveState.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]!;
    if (m.channelId === channelId && canEdit(m)) return m;
  }
  return null;
}

/**
 * Saves the draft; unchanged text just closes, as in Discord. Emptied text on a message with nothing else offers to delete
 * it instead (Discord refuses an empty message); declining keeps the editor open. The row shows the new text once the
 * archive has the update.
 */
export async function saveEdit(): Promise<void> {
  const d = draft();
  if (!d) return;
  const m = d.message;
  if (!d.text.trim() && !m.attachments.length && !m.stickers.length) {
    await confirmDelete(m);
    return;
  }
  if (d.text !== m.content) await api.discord.edit({ channelId: m.channelId, messageId: m.id, text: d.text });
  if (draft()?.session === d.session) setDraft(null);
}

/** A panel window's Edit, handed over: the Archive shows the message (alerts.ts), and its editor opens; ignored while posting is locked. */
onAppEvent('open-message', async (e) => {
  if (e.compose !== 'edit' || !e.messageId || !postingUnlocked()) return;
  const m = await api.core.messageById(e.messageId);
  if (m && canEdit(m) && postingUnlocked()) startEdit(m);
});
