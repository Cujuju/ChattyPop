// A message's right-click menu: what was pressed (an attachment's Download), copies, views, Jev and plugin groups; posting
// items come from a posting plugin.
import { api } from '@/api';
import { HOST_ATTACHMENT_MENU_ITEMS } from '@shared/anchors';
import type { ArchiveAttachment, ArchiveMessage, AttachmentNote } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { channelJevItems, jevMayRead } from './channelPolicy';
import { channelById } from './directory';
import { openConversation } from './conversation';
import { canReact } from './reactions';
import { openPerson } from './person';
import { aiSettings } from './preferences';
import { attachmentMenuItems, messageMenuGroups, type MessageMenuScope } from '@/plugins/slots';
import type { HostAttachmentMenuItem } from '@/plugins/readSlots';
import { openContextMenu, setJevCheckFor, type MenuItem } from './ui';
import { failureNotice } from './dialogs';
import { canSave, saveAttachment } from './savedFiles';

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

/** Starts clipboard writes within taps using pending PNG promises, preserving Safari activation. Failures alert after menu closure. */
function copyImage(src: string): Promise<void> {
  return navigator.clipboard
    .write([new ClipboardItem({ 'image/png': pngOf(src) })])
    .catch(failureNotice("Couldn't copy the image"));
}

/** The note of `m` that `target` is in, if any: its element carries data-note-part and data-note-plugin (panels/chat/Attachment.tsx). */
function pressedNote(target: EventTarget | null, m: ArchiveMessage): AttachmentNote | undefined {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-note-part]') : null;
  if (!el) return undefined;
  return [m, ...m.attachments, ...m.embeds].flatMap((x) => x.notes ?? []).find((n) => n.part === el.dataset.notePart && n.pluginId === el.dataset.notePlugin);
}

/**
 * The attachment of `m` that `target` is in, if any, and its player when it plays inline: its tile carries
 * data-attachment-id (panels/chat/AttachmentTile.tsx).
 */
function pressedAttachment(target: EventTarget | null, m: ArchiveMessage): { attachment: ArchiveAttachment; player: HTMLMediaElement | null } | undefined {
  const tile = target instanceof Element ? target.closest<HTMLElement>('[data-attachment-id]') : null;
  const attachment = tile ? m.attachments.find((a) => a.id === tile.dataset.attachmentId) : undefined;
  return attachment && { attachment, player: tile!.querySelector('audio, video') };
}

/** Playback speeds offered, as Chromium's own player menu offers them (the player's menu is hidden: Attachment.tsx). */
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const NORMAL_RATE = 1;

/** The player's speed as a choice of PLAYBACK_RATES; the choice applies to this player only, as the native menu's did. */
const speedItem = (player: HTMLMediaElement): MenuItem => ({
  label: 'Playback speed',
  icon: 'speed',
  submenu: [{
    exclusive: true,
    items: PLAYBACK_RATES.map((rate) => ({
      label: rate === NORMAL_RATE ? 'Normal' : `${rate}×`,
      icon: 'speed',
      checked: player.playbackRate === rate,
      run: () => void (player.playbackRate = rate),
    })),
  }],
});

/** The host's items for a pressed attachment: its player's speed, Download while its file is held here; modify and delete are anchors. */
const hostAttachmentItems = (player: HTMLMediaElement | null): HostAttachmentMenuItem[] =>
  HOST_ATTACHMENT_MENU_ITEMS.map((id) => ({
    id,
    item: (_m, a) => {
      if (id === 'speed') return player && speedItem(player);
      return id === 'download' && canSave(a) ? { label: 'Download', icon: 'download', run: () => saveAttachment(a) } : null;
    },
  }));

export type { MessageMenuScope };
const FULL_ROW: MessageMenuScope = { drawsAttachments: true };

/**
 * Opens a message's right-click menu: what was right-clicked (selection, a note's text), the pressed attachment's items,
 * quick reactions, views, copies (the pressed image's too), plugins' groups and Jev. A posting plugin adds Reply and Forward before the views, Delete last,
 * and an attachment's Modify and Delete.
 */
export function openMessageMenu(e: MouseEvent, m: ArchiveMessage, scope: MessageMenuScope = FULL_ROW): void {
  const target: MenuItem[] = [];
  const selection = window.getSelection()?.toString() ?? '';
  if (selection.trim()) target.push({ label: 'Copy selection', icon: 'copy', run: () => navigator.clipboard.writeText(selection) });
  // A transcription can't be selected on the phone (a long press opens this menu): copied whole from here.
  const note = pressedNote(e.target, m);
  if (note) target.push({ label: 'Copy text', icon: 'copy', run: () => navigator.clipboard.writeText(note.text) });

  const pressed = pressedAttachment(e.target, m);
  const attachment = pressed ? attachmentMenuItems(m, pressed.attachment, hostAttachmentItems(pressed.player)) : [];

  const copy: MenuItem[] = m.content ? [{ label: 'Text', icon: 'text', run: () => navigator.clipboard.writeText(m.content) }] : [];
  // The pressed image, an attachment's or an embed's; not an avatar.
  const img = (e.target as HTMLElement).closest('img');
  if (img && !img.closest('[data-avatar]')) copy.push({ label: 'Image', icon: 'image', run: () => copyImage(img.currentSrc || img.src) });
  copy.push({ label: 'Message link', icon: 'link', run: () => navigator.clipboard.writeText(messageLink(m)) }, { label: 'Message ID', icon: 'id', run: () => navigator.clipboard.writeText(m.id) });

  const jev: MenuItem[] = aiSettings().jev.messageCheck && m.content && jevMayRead(m.channelId) ? [{ label: 'Check this message…', icon: 'jev', run: () => void setJevCheckFor(m) }] : [];
  jev.push(...channelJevItems(m.channelId));

  const views: MenuItem[] = [
    { label: 'View conversation', icon: 'conversation', run: () => openConversation(m.id) },
    { label: `View ${m.author.name}`, icon: 'person', run: () => openPerson(m.author.id) },
  ];

  openContextMenu(e, messageMenuGroups(m, scope, [
    { id: 'selection', items: target },
    { id: 'attachment', items: attachment },
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
