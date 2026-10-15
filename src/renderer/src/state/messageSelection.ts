// The Archive view's select mode and the messages ticked in it, to act on together. Ticks belong to the channel shown; never stored.
import { createSignal } from 'solid-js';
import { batchWrites } from '@plugin-sdk/renderer/containment';
import type { ArchiveMessage } from '@shared/contract';
import { compareSnowflakes } from '@shared/discord';

const NONE: ReadonlyMap<string, ArchiveMessage> = new Map();
const [selection, setSelection] = createSignal(NONE);
const [mode, setMode] = createSignal(false);
/** The message last ticked or unticked: a range runs from it. */
let anchorId: string | null = null;

/** Select mode is on (the chat header's Select): a click on a row ticks it instead of acting on what it holds. */
export const selecting = mode;
export const isSelected = (messageId: string): boolean => selection().has(messageId);
/** The selected messages, oldest first. */
export const selectedMessages = (): ArchiveMessage[] => [...selection().values()].sort((a, b) => compareSnowflakes(a.id, b.id));

/** The ticks a tick of `m` adds to: none when they are another channel's, so a selection is always of one channel. */
const ticksFor = (m: ArchiveMessage): Map<string, ArchiveMessage> => {
  const ticks = selection();
  return new Map(ticks.values().next().value?.channelId === m.channelId ? ticks : NONE);
};

/** Ticks `m`, or unticks it. */
export function toggleSelected(m: ArchiveMessage): void {
  const next = ticksFor(m);
  if (!next.delete(m.id)) next.set(m.id, m);
  anchorId = m.id;
  setSelection(next);
}

/** Ticks every message of `loaded` (the view's, in order) from the last ticked one to `m`; `m` alone when that one isn't loaded. */
export function selectThrough(m: ArchiveMessage, loaded: readonly ArchiveMessage[]): void {
  const from = loaded.findIndex((x) => x.id === anchorId);
  const to = loaded.findIndex((x) => x.id === m.id);
  const range = from < 0 || to < 0 ? [m] : loaded.slice(Math.min(from, to), Math.max(from, to) + 1);
  const next = ticksFor(m);
  for (const x of range) next.set(x.id, x);
  anchorId = m.id;
  setSelection(next);
}

/** Unticks every message; select mode stays on. */
export function clearTicks(): void {
  anchorId = null;
  setSelection(NONE);
}

export const startSelecting = (): void => void setMode(true);

/** Leaves select mode, dropping the ticks. */
export const stopSelecting = (): void => batchWrites(() => {
  clearTicks();
  setMode(false);
});
