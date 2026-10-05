// The owner's attachments on their own messages: Discord's Modify Attachment (alt text, spoiler) and Delete, each asked
// in a dialog first. Both save as an edit of the message's kept attachments.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { KeptAttachment } from '@shared/compose';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import { spoilerName } from '@shared/media';
import { canDelete, confirmDelete } from './ownMessages';
import { closeWhenLocked, postingUnlocked } from './posting';

/** An attachment of a message, as a dialog holds it. */
export interface MessageAttachment {
  message: ArchiveMessage;
  attachment: ArchiveAttachment;
}

/** Whether the owner may modify or delete `a`: on their own message still on Discord, and still on that message. */
export const canChangeAttachment = (m: ArchiveMessage, a: ArchiveAttachment): boolean => canDelete(m) && !a.removed;

const [modifying, setModifying] = createSignal<MessageAttachment | null>(null);
const [deleting, setDeleting] = createSignal<MessageAttachment | null>(null);
/** The attachment the Modify dialog edits, or null while it is closed. */
export const modifyingAttachment = modifying;
/** The attachment the delete dialog asks about, or null while it is closed. */
export const deletingAttachment = deleting;
export const closeModifyAttachment = (): void => void setModifying(null);
export const closeDeleteAttachment = (): void => void setDeleting(null);
closeWhenLocked(() => modifying() !== null, closeModifyAttachment);
closeWhenLocked(() => deleting() !== null, closeDeleteAttachment);

/** The bar's Modify: opens its dialog; never while posting is locked. */
export function modifyAttachment(message: ArchiveMessage, attachment: ArchiveAttachment): void {
  if (postingUnlocked()) setModifying({ message, attachment });
}

/** The bar's Delete: opens the dialog that asks first; never while posting is locked. */
export function deleteAttachment(message: ArchiveMessage, attachment: ArchiveAttachment): void {
  if (postingUnlocked()) setDeleting({ message, attachment });
}

/** The attachments `m` keeps on Discord, as an edit names them. */
const kept = (m: ArchiveMessage): KeptAttachment[] =>
  m.attachments.filter((a) => !a.removed).map((a) => ({ id: a.id, filename: a.filename, description: a.description }));

/** What Modify can change: alt text (empty clears it) and the spoiler mark. */
export interface AttachmentChange {
  description: string;
  spoiler: boolean;
}

/** Saves Modify's change; the row shows it once the archive has Discord's update. Rejects with Discord's reason. */
export async function saveAttachment(t: MessageAttachment, change: AttachmentChange): Promise<void> {
  const attachments = kept(t.message).map((a) =>
    a.id === t.attachment.id ? { ...a, filename: spoilerName(a.filename, change.spoiler), description: change.description.trim() || null } : a,
  );
  await api.discord.edit({ channelId: t.message.channelId, messageId: t.message.id, attachments });
}

/** Whether deleting `t`'s attachment leaves its message empty, which Discord refuses: the message is deleted instead. */
export const deletesMessage = (t: MessageAttachment): boolean =>
  !t.message.content.trim() && !t.message.stickers.length && kept(t.message).every((a) => a.id === t.attachment.id);

/** Removes the attachment from its message; the archive keeps it, marked removed. Rejects with Discord's reason. */
export async function confirmDeleteAttachment(t: MessageAttachment): Promise<void> {
  if (deletesMessage(t)) return confirmDelete(t.message);
  await api.discord.edit({ channelId: t.message.channelId, messageId: t.message.id, attachments: kept(t.message).filter((a) => a.id !== t.attachment.id) });
}
