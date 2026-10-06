// When the Archive moves a channel's last-read mark. Pure: tests import it.
/** Returns newest seen message only after ready-channel banner loads. Missing or already-marked messages return undefined. */
export function messageToMark(channelId: string | null, ready: string | null, seen: string | undefined, marked: string | undefined): string | undefined {
  return channelId !== null && channelId === ready && seen !== undefined && seen !== marked ? seen : undefined;
}

/** Checks whether first unread is above loaded/drawn viewport. Onscreen or below-viewport messages count as reached. */
export function firstUnreadAbove(
  first: { firstId: string; firstTs: number },
  loaded: readonly { id: string; ts: number }[],
  drawn: readonly string[],
  rowTop: number | null,
  viewTop: number,
): boolean {
  const at = loaded.findIndex((m) => m.id === first.firstId);
  if (at < 0) return loaded.length === 0 || first.firstTs <= loaded[0]!.ts;
  if (rowTop !== null) return rowTop < viewTop;
  const firstDrawn = loaded.findIndex((m) => drawn.includes(m.id));
  return firstDrawn >= 0 && at < firstDrawn;
}
