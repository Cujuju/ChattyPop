import type { ArchiveEmbed, ArchiveMessage, AttachmentNote, MessageLabel } from '@shared/contract';
import { questionLabels } from '../jev/messageQuestions';
import { partNotes } from '../attachmentNotes';
import { messageLabels } from '../messageLabels';
import { embedPartKeys, partKey } from '../messageParts';

export interface MessageSnapshot {
  items: ArchiveMessage[];
  judgments: { messageId: string; subject: string; value: number; label: string | null }[];
}

/** Adds live plugin notes and labels only on Core; the archive snapshot itself is read in a helper. */
export function decorateMessages({ items, judgments }: MessageSnapshot): ArchiveMessage[] {
  if (!items.length) return [];
  const ids = items.map((m) => m.id);
  const notes = partNotes(items.map((m) => ({ id: m.id, attachmentIds: m.attachments.map((a) => a.id) })));
  const labelFor = questionLabels();
  const labels = new Map<string, MessageLabel[]>();
  for (const stored of judgments) {
    const asked = labelFor.get(stored.subject);
    const text = asked?.label({ value: stored.value, label: stored.label });
    if (!asked || !text) continue;
    const owner = asked.pluginId === null ? {} : { pluginId: asked.pluginId };
    const own = labels.get(stored.messageId) ?? [];
    own.push({ subject: stored.subject, text, title: "Jev's label for this message (a model's estimate)", ...owner });
    labels.set(stored.messageId, own);
  }
  for (const [id, own] of messageLabels(ids)) labels.set(id, [...(labels.get(id) ?? []), ...own]);
  return items.map((m) => ({
    ...m,
    embeds: withEmbedNotes(m.embeds, notes.get(m.id)),
    attachments: m.attachments.map((a) => ({ ...a, notes: notes.get(m.id)?.get(partKey.attachment(a.id)) ?? [] })),
    notes: [...(notes.get(m.id) ?? [])].flatMap(([part, list]) => part.startsWith(partKey.linkText('')) ? list : []),
    labels: labels.get(m.id) ?? [],
  }));
}

/** A part shown by two embeds gets its notes only on the first. */
function withEmbedNotes(embeds: ArchiveEmbed[], notes: Map<string, AttachmentNote[]> | undefined): ArchiveEmbed[] {
  if (!notes) return embeds;
  const drawn = new Set<string>();
  return embeds.map((e, i) => {
    const keys = embedPartKeys(e, i).filter((k) => !drawn.has(k));
    for (const k of keys) drawn.add(k);
    return { ...e, notes: keys.flatMap((k) => notes.get(k) ?? []) };
  });
}
