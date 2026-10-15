// Which copy of a stored message wins: Discord's edit time orders versions; a full payload refreshes the stored one.
import type { RawMessage } from '@shared/discord';

/** Keys a full Discord message leaves out when empty: missing from one means none now. */
const OMITTED_WHEN_EMPTY = ['reactions'] as const;

/** Whether a copy edited at `incoming` (null: never edited) predates the stored version edited at `stored`. */
export const olderVersion = (incoming: number | null, stored: number | null): boolean => stored !== null && (incoming === null || incoming < stored);

/** A full payload over the stored one: its fields win; keys only gateway payloads carry (nonce, member) stay. */
export function mergeFullPayload(stored: object | null, full: RawMessage): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored, ...full };
  for (const key of OMITTED_WHEN_EMPTY) if (!(key in full)) delete merged[key];
  return merged;
}
