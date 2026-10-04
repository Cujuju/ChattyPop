// A message's right-click menu: copies, views, Jev and plugin groups; posting items come from a posting plugin.
import { api } from '@/api';
import type { ArchiveMessage, AttachmentNote } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { channelJevItems, jevMayRead } from './channelPolicy';
import { channelById } from './directory';
import { openConversation } from './conversation';
import { canReact } from './reactions';
import { openPerson } from './person';
import { aiSettings } from './preferences';
import { messageMenuGroups, type MessageMenuScope } from '@/plugins/slots';
import { openContextMenu, setJevCheckFor, type MenuItem } from './ui';
import { errorText } from '@/ui/format';

const DISCORD_APP = 'https://discord.com/channels';

/** The message's Discord link (opens it in any Discord client). */
export function messageLink(m: ArchiveMessage): string {
  const guildId = channelById(m.channelId)?.guildId ?? DM_GUILD_ID;
  return `${DISCORD_APP}/${guildId}/${m.channelId}/${m.id}`;
}

/** The image as PNG, the one image type the clipboard takes; other formats are re-encoded through a canvas. */
async function pngOf(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image could not be encoded'))), 'image/png'));
}

/**
 * Copies an image. The write starts within the tap with the PNG still on its way: Safari refuses a clipboard write that
 * waits for a fetch first. A failure shows as an alert: the menu has closed.
 */
function copyImage(src: string): Promise<void> {
  return navigator.clipboard
    .write([new ClipboardItem({ 'image/png': pngOf(src) })])
    .catch((err: unknown) => window.alert(`Couldn't copy the image: ${errorText(err)}`));
}

/** The note of `m` that `target` is in, if any: its element carries data-note-part and data-note-plugin (panels/chat/Attachment.tsx). */
function pressedNote(target: EventTarget | null, m: ArchiveMessage): AttachmentNote | undefined {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-note-part]') : null;
  if (!el) return undefined;
  return [m, ...m.attachments, ...m.embeds].flatMap((x) => x.notes ?? []).find((n) => n.part === el.dataset.notePart && n.pluginId === el.dataset.notePlugin);
}

export type { MessageMenuScope };
const FULL_ROW: MessageMenuScope = { drawsAttachments: true };

/**
 * Opens a message's right-click menu: what was right-clicked (selection, image), quick reactions, views, copies, plugins'
 * groups and Jev. A posting plugin adds Reply and Forward before the views, Delete last.
 */
export function openMessageMenu(e: MouseEvent, m: ArchiveMessage, scope: MessageMenuScope = FULL_ROW): void {
  const target: MenuItem[] = [];
  const selection = window.getSelection()?.toString() ?? '';
  if (selection.trim()) target.push({ label: 'Copy selection', icon: 'copy', run: () => navigator.clipboard.writeText(selection) });
  const img = (e.target as HTMLElement).closest('img');
  if (img && !img.closest('[data-avatar]')) target.push({ label: 'Copy image', icon: 'image', run: () => copyImage(img.currentSrc || img.src) });
  // A transcription can't be selected on the phone (a long press opens this menu): copied whole from here.
  const note = pressedNote(e.target, m);
  if (note) target.push({ label: 'Copy text', icon: 'copy', run: () => navigator.clipboard.writeText(note.text) });

  const copy: MenuItem[] = m.content ? [{ label: 'Text', icon: 'text', run: () => navigator.clipboard.writeText(m.content) }] : [];
  copy.push({ label: 'Message link', icon: 'link', run: () => navigator.clipboard.writeText(messageLink(m)) }, { label: 'Message ID', icon: 'id', run: () => navigator.clipboard.writeText(m.id) });

  const jev: MenuItem[] = aiSettings().jev.messageCheck && m.content && jevMayRead(m.channelId) ? [{ label: 'Check this message…', icon: 'jev', run: () => void setJevCheckFor(m) }] : [];
  jev.push(...channelJevItems(m.channelId));

  const views: MenuItem[] = [
    { label: 'View conversation', icon: 'conversation', run: () => openConversation(m.id) },
    { label: `View ${m.author.name}`, icon: 'person', run: () => openPerson(m.author.id) },
  ];

  openContextMenu(e, messageMenuGroups(m, scope, [
    { id: 'selection', items: target },
    { id: 'views', items: views },
    { id: 'copy', heading: 'Copy', items: copy },
    { id: 'jev', heading: 'Jev', items: jev },
    { id: 'delete', items: [] },
  ]), { reactTo: canReact(m) ? m : undefined, messageId: m.id });
}

/** The message menu for a row that holds only the message's id (an alert). Fetched on open, so tag items are current. */
export async function openMessageMenuById(e: MouseEvent, messageId: string, scope: MessageMenuScope): Promise<void> {
  e.preventDefault();
  const m = await api.core.messageById(messageId);
  // Null only when privacy mode hid the message after the row was drawn.
  if (m) openMessageMenu(e, m, scope);
}
