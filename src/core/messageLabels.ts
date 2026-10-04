// Plugin labels merged into archive pages, in build order.
import type { MessageLabel } from '@shared/contract';

/** A plugin label; the host supplies its owner. */
export type PluginLabel = Omit<MessageLabel, 'pluginId'>;
/** Synchronous labels for one page of messages. */
export type MessageLabelProvider = (messageIds: string[]) => Map<string, PluginLabel[]>;
const providers = new Map<string, {
  rank: number;
  fn: MessageLabelProvider;
}>();

/** Registers a page provider and returns an identity-safe disposer. */
export function registerMessageLabels(id: string, rank: number, fn: MessageLabelProvider): () => void {
  const entry = {
    rank,
    fn,
  };
  providers.set(id, entry);
  return () => {
    if (providers.get(id) === entry) providers.delete(id);
  };
}

/** Labels from active providers, with ownership stamped by the host. */
export function messageLabels(ids: string[]): Map<string, MessageLabel[]> {
  const out = new Map<string, MessageLabel[]>();
  if (!ids.length) return out;
  for (const [pluginId, { fn }] of [...providers].sort((a, b) => a[1].rank - b[1].rank)) {
    for (const [id, labels] of fn(ids)) out.set(
      id,
      [...(out.get(id) ?? []), ...labels.map((label) => ({
        ...label,
        pluginId,
      }))],
    );
  }
  return out;
}
