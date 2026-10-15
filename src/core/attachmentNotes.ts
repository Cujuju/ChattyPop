// Notes plugins attach to a message's parts (a transcript, a translation, and where making it has got to), drawn under
// the attachment or embed they are of.
import type { AttachmentNote } from '@shared/contract';
import { partKey } from './messageParts';

/** A note as a plugin gives it; the host adds its plugin and part. */
export type PluginNote = Omit<AttachmentNote, 'pluginId' | 'part'>;

/** A plugin's notes for these attachments, by attachment id; synchronous, as it runs inside a page read. */
export type AttachmentNoteProvider = (attachmentIds: string[]) => Map<string, PluginNote>;

/** A plugin's notes for these messages' parts: by message id, then part key (messageParts); synchronous, as above. */
export type PartNoteProvider = (messageIds: string[]) => Map<string, Map<string, PluginNote>>;

type Provider = { rank: number; attachments: AttachmentNoteProvider } | { rank: number; parts: PartNoteProvider };

/** By plugin id; notes are listed in each provider's `rank` (its plugin's build order). */
const providers = new Map<string, Provider>();

/** Holds `provider` as `pluginId`'s until the returned disposer runs; a disposer never removes a later registration. */
function register(pluginId: string, provider: Provider): () => void {
  providers.set(pluginId, provider);
  return () => {
    if (providers.get(pluginId) === provider) providers.delete(pluginId);
  };
}

export const registerAttachmentNotes = (pluginId: string, rank: number, fn: AttachmentNoteProvider): (() => void) => register(pluginId, { rank, attachments: fn });

export const registerPartNotes = (pluginId: string, rank: number, fn: PartNoteProvider): (() => void) => register(pluginId, { rank, parts: fn });

/** These messages' notes, by message id then part key, each part's in plugin build order; parts without any are absent. */
export function partNotes(messages: readonly { id: string; attachmentIds: readonly string[] }[]): Map<string, Map<string, AttachmentNote[]>> {
  const notes = new Map<string, Map<string, AttachmentNote[]>>();
  if (!messages.length) return notes;
  const add = (messageId: string, part: string, note: AttachmentNote): void => {
    const parts = notes.get(messageId) ?? new Map<string, AttachmentNote[]>();
    parts.set(part, [...(parts.get(part) ?? []), note]);
    notes.set(messageId, parts);
  };
  const messageOf = new Map(messages.flatMap((m) => m.attachmentIds.map((a) => [a, m.id] as const)));
  for (const [pluginId, p] of [...providers].sort((a, b) => a[1].rank - b[1].rank)) {
    if ('attachments' in p) {
      if (!messageOf.size) continue;
      for (const [id, note] of p.attachments([...messageOf.keys()])) {
        const messageId = messageOf.get(id);
        const part = partKey.attachment(id);
        if (messageId) add(messageId, part, { pluginId, part, ...note });
      }
    } else {
      for (const [messageId, parts] of p.parts(messages.map((m) => m.id))) {
        for (const [part, note] of parts) add(messageId, part, { pluginId, part, ...note });
      }
    }
  }
  return notes;
}
