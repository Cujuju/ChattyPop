// Link platforms: the link index sorts each shared link into one (derive/links.ts); rules and the Links plugin filter by them.
export const PLATFORMS = ['youtube', 'reddit', 'x', 'instagram', 'bluesky', 'tiktok', 'twitch', 'threads', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Post id in an X link: /<user>/status/<id>, /i/web/status/<id>, legacy /statuses/<id>. */
export const X_STATUS_PATH = /\/status(?:es)?\/(\d+)/;

/** F2 badge text and filter label per platform. */
export const PLATFORM_INFO: Record<Platform, { badge: string; label: string }> = {
  youtube: { badge: 'YT', label: 'YouTube' },
  reddit: { badge: 'RD', label: 'Reddit' },
  x: { badge: 'X', label: 'X' },
  instagram: { badge: 'IG', label: 'Instagram' },
  bluesky: { badge: 'BS', label: 'Bluesky' },
  tiktok: { badge: 'TT', label: 'TikTok' },
  twitch: { badge: 'TW', label: 'Twitch' },
  threads: { badge: 'TH', label: 'Threads' },
  other: { badge: 'WEB', label: 'Other sites' },
};
