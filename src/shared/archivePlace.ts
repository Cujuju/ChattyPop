// Where the owner was in a channel's Archive log, kept across restarts (the desktop's setting, the phone's storage).

/** A message and its bottom edge above the view's bottom, in pixels (the virtual log's `bottomOf`). */
export interface ArchivePlace {
  channelId: string;
  messageId: string;
  bottom: number;
}

/** `v` as a place, or null when it is anything else (nothing kept, damaged). */
export function normalizeArchivePlace(v: unknown): ArchivePlace | null {
  if (typeof v !== 'object' || v === null) return null;
  const { channelId, messageId, bottom } = v as Record<string, unknown>;
  return typeof channelId === 'string' && typeof messageId === 'string' && typeof bottom === 'number' && Number.isFinite(bottom)
    ? { channelId, messageId, bottom }
    : null;
}
