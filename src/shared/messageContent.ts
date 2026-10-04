// What a message carries besides its text, as a topic's "Contains" condition checks it (after Discord search's has:).

export const CONTENT_KINDS = ['voice', 'audio', 'image', 'video', 'file', 'mediaLink', 'link', 'sticker', 'poll', 'forward'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** A stored message's values as rule actions use them (a file action's author and link; plugins' post placeholders). */
export interface MessageValues {
  /** Its own text. */
  text: string;
  /** Transcripts of its voice message or audio, done ones only, in order. */
  transcript: string;
  /** The author's name as Discord shows it (server nickname, else display name). */
  author: string;
  /** The author's unique @handle. */
  username: string;
  /** An @mention of the author. */
  mention: string;
  /** A link to its channel. */
  channel: string;
  /** A link to the message. */
  jump: string;
  /** The links in it, one per line. */
  links: string;
}

/** Editor label and hint per kind. */
export const CONTENT_KIND_INFO: Readonly<Record<ContentKind, { label: string; hint: string }>> = {
  voice: { label: 'Voice message', hint: "Recorded in Discord's voice message button." },
  audio: { label: 'Audio', hint: 'Any audio file, voice messages included.' },
  image: { label: 'Image', hint: 'An attached image or GIF.' },
  video: { label: 'Video', hint: 'An attached video.' },
  file: { label: 'File', hint: 'Any attachment.' },
  mediaLink: { label: 'Media link', hint: 'A YouTube, X, Reddit, Instagram, Bluesky, TikTok, Twitch or Threads link.' },
  link: { label: 'Link', hint: 'A link to any site.' },
  sticker: { label: 'Sticker', hint: 'A Discord sticker.' },
  poll: { label: 'Poll', hint: 'A Discord poll.' },
  forward: { label: 'Forward', hint: 'A message forwarded from elsewhere.' },
};

/** Kinds a more specific kind implies; a summary names only the specific one. */
const IMPLIED: Partial<Record<ContentKind, ContentKind[]>> = {
  voice: ['audio', 'file'],
  audio: ['file'],
  image: ['file'],
  video: ['file'],
  mediaLink: ['link'],
};

/** e.g. "Voice message, Image". */
export const contentLabels = (kinds: readonly ContentKind[]): string => kinds.map((k) => CONTENT_KIND_INFO[k].label).join(', ');

export const isContentKinds = (v: unknown): v is ContentKind[] => Array.isArray(v) && v.every((k) => (CONTENT_KINDS as readonly unknown[]).includes(k));

/** e.g. "[Voice message]": stands in for the text of a message that has none. */
export function contentSummary(kinds: ReadonlySet<ContentKind>): string {
  const implied = new Set([...kinds].flatMap((k) => IMPLIED[k] ?? []));
  const named = CONTENT_KINDS.filter((k) => kinds.has(k) && !implied.has(k));
  return named.length ? `[${contentLabels(named)}]` : '';
}
