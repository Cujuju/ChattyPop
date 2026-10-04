// Adjacent grouped shortcut hints share a label without changing key placement.
/** Display metadata for one key or combined key group. */
export interface GroupedHint {
  id: string;
  keys: string;
  hint: string;
  hintGroup?: string;
}

/** Combines adjacent hints explicitly declaring the same group and label. */
export function groupShortcutHints(hints: readonly GroupedHint[]): GroupedHint[] {
  const result: GroupedHint[] = [];
  for (const hint of hints) {
    const previous = result.at(-1);
    if (hint.hintGroup && previous?.hintGroup === hint.hintGroup && previous.hint === hint.hint) {
      previous.keys += ` ${hint.keys}`;
    } else result.push({ ...hint });
  }
  return result;
}
