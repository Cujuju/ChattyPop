// Token-preserving snippets shared by archive search, activity and plugin rows.
import { cutOutsideTokens } from '@shared/discordText';

/** Context kept around the match in an alert snippet. */
const SNIPPET_BEFORE_CHARS = 60;
const SNIPPET_MAX_CHARS = 200;

/** Builds approximately maxChars match-centered snippets, or leading text for meaning matches. Keeps Discord tokens intact. */
export function snippet(content: string, re: RegExp | null, maxChars = SNIPPET_MAX_CHARS): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const at = re ? Math.max(0, flat.search(re)) : 0;
  const start = cutOutsideTokens(flat, Math.max(0, at - SNIPPET_BEFORE_CHARS), false);
  const end = cutOutsideTokens(flat, start + maxChars, true);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

