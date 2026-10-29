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

/** What can change whether the Archive's read marks wait for a deliberate act. */
export type ReadHoldEvent =
  /** The owner stopped looking; `caughtUp` = the newest loaded message was marked. */
  | { kind: 'away'; caughtUp: boolean }
  | { kind: 'back' }
  /** A channel came on; `deliberate` = switched to while looking, not restored. */
  | { kind: 'opened'; deliberate: boolean }
  /** A message row loaded while the owner was not looking. */
  | { kind: 'arrived' }
  /** Stored unread answered; `any` = something is unread, `looking` = the owner looked when it answered. */
  | { kind: 'unread'; any: boolean; looking: boolean }
  /** A scroll gesture, banner dismissal, or jump. */
  | { kind: 'act' };

/** Desktop: after a return, arrival or restore, marks wait for an act while storage holds unread. Rows load late while hidden. Companion releases on return. */
export function nextReadHold(held: boolean, e: ReadHoldEvent, companion: boolean): boolean {
  switch (e.kind) {
    case 'act': return false;
    case 'away': return companion ? held || e.caughtUp : true;
    case 'back': return !companion;
    case 'opened': return !companion && !e.deliberate;
    case 'arrived': return companion ? held : true;
    case 'unread': return companion ? held : held && (e.any || !e.looking);
  }
}
