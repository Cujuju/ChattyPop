// When the Archive moves a channel's last-read mark. Pure: tests import it.
/**
 * The message to mark read: `seen`, the newest message on screen, once the banner for `ready` (the channel whose
 * unread was read on coming on screen) is in, so marking never hides what the banner should count. Undefined when
 * there is nothing to mark, or it was marked already (`marked`).
 */
export function messageToMark(channelId: string | null, ready: string | null, seen: string | undefined, marked: string | undefined): string | undefined {
  return channelId !== null && channelId === ready && seen !== undefined && seen !== marked ? seen : undefined;
}

/**
 * Whether the banner's first unread message (`first`) lies above the view, so the banner still points to it: older
 * than the loaded window, drawn with its top above the view's top, or loaded but older than every drawn row. On screen
 * or below the view (scrolled further up), the owner has reached it.
 */
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
