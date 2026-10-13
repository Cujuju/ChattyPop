// The messages ticked in the Archive view, to act on together. Belongs to the channel shown; never stored.
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { compareSnowflakes } from '@shared/discord';

const NONE: ReadonlyMap<string, ArchiveMessage> = new Map();
const [selection, setSelection] = createSignal(NONE);
/** The message last ticked or unticked: a range runs from it. */
let anchorId: string | null = null;

/** Messages are being selected: a click on a row ticks it instead of acting on what it holds. */
export const selecting = (): boolean => selection().size > 0;
export const isSelected = (messageId: string): boolean => selection().has(messageId);
/** The selected messages, oldest first. */
export const selectedMessages = (): ArchiveMessage[] => [...selection().values()].sort((a, b) => compareSnowflakes(a.id, b.id));

/** Ticks `m`, or unticks it; unticking the last one leaves selection. */
export function toggleSelected(m: ArchiveMessage): void {
  const next = new Map(selection());
  if (!next.delete(m.id)) next.set(m.id, m);
  anchorId = m.id;
  setSelection(next);
}

/** Ticks every message of `loaded` (the view's, in order) from the last ticked one to `m`; `m` alone when that one isn't loaded. */
export function selectThrough(m: ArchiveMessage, loaded: readonly ArchiveMessage[]): void {
  const from = loaded.findIndex((x) => x.id === anchorId);
  const to = loaded.findIndex((x) => x.id === m.id);
  const range = from < 0 || to < 0 ? [m] : loaded.slice(Math.min(from, to), Math.max(from, to) + 1);
  const next = new Map(selection());
  for (const x of range) next.set(x.id, x);
  anchorId = m.id;
  setSelection(next);
}

export function clearSelection(): void {
  anchorId = null;
  setSelection(NONE);
}
