// Local covers identify the selected upload, or a link within one message; Discord's message stays untouched.
export const normalizeLocalSpoilers = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0))] : [];

/** Canonical URL spelling keeps bare Markdown links and their embed cards on the same local mark. */
export const canonicalSpoilerLink = (url: string): string => {
  try { return new URL(url).href; } catch { return url; }
};

export const attachmentSpoilerKey = (id: string): string => JSON.stringify(['attachment', id]);
export const linkSpoilerKey = (messageId: string, url: string): string => JSON.stringify(['link', messageId, canonicalSpoilerLink(url)]);
/** URL-less rich embeds have only their place within the message to identify them. */
export const embedSpoilerKey = (messageId: string, index: number): string => JSON.stringify(['embed', messageId, index]);
