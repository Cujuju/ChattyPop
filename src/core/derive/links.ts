import * as linkify from 'linkifyjs';
import { X_STATUS_PATH, type Platform } from '@shared/links';

export interface ExtractedLink {
  url: string;
  platform: Platform;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  site: string | null;
}

interface RawEmbed {
  url?: string;
  title?: string;
  description?: string;
  provider?: { name?: string };
  thumbnail?: { url?: string; proxy_url?: string };
  image?: { url?: string; proxy_url?: string };
}

/** Maps hostname suffixes and known embed-fixer mirrors to platforms. Unlisted mirrors remain other links. */
const PLATFORM_HOSTS: [RegExp, Platform][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(reddit\.com|redd\.it|vxreddit\.com|rxddit\.com)$/, 'reddit'],
  [/(^|\.)(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/, 'x'],
  [/(^|\.)(instagram\.com|ddinstagram\.com|eeinstagram\.com)$/, 'instagram'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)(tiktok\.com|vxtiktok\.com|tnktok\.com)$/, 'tiktok'],
  [/(^|\.)twitch\.tv$/, 'twitch'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
];

/** Discord's own CDN/app links are attachments or jumps, not shared media. */
const IGNORED_HOSTS = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg)$/;

export function classify(url: string): Platform {
  const host = new URL(url).hostname.toLowerCase();
  return PLATFORM_HOSTS.find(([re]) => re.test(host))?.[1] ?? 'other';
}

/** Query params kept per platform; everything else is sharing/tracking noise. */
const KEPT_PARAMS: Partial<Record<Platform, string[]>> = { youtube: ['v', 'list'] };
const X_HOST = 'x.com';
const X_POST_PATH = '/i/status/';
/** A canonical X post link up to its id (normalizeUrl's form); fetched posts join to links on it. */
export const X_POST_URL_PREFIX = `https://${X_HOST}${X_POST_PATH}`;
/** Platforms whose links are canonicalized to one host so mirrors and short links dedupe. */
const CANONICAL_HOST: Partial<Record<Platform, string>> = {
  youtube: 'www.youtube.com',
  x: X_HOST,
  instagram: 'www.instagram.com',
  tiktok: 'www.tiktok.com',
  reddit: 'www.reddit.com',
};
const YOUTU_BE = /(^|\.)youtu\.be$/;
const REDD_IT = /(^|\.)redd\.it$/;
export { X_STATUS_PATH };
/** Canonicalizes post URLs across slugs, prefixes and fixer mirrors. X and Reddit use post ids; unresolved Reddit share codes remain separate. */
const POST_PATH: Partial<Record<Platform, { re: RegExp; path: (id: string) => string }>> = {
  x: { re: X_STATUS_PATH, path: (id) => `${X_POST_PATH}${id}` },
  reddit: { re: /\/comments\/([a-z0-9]+)/i, path: (id) => `/comments/${id.toLowerCase()}` },
};

/** Canonical form for dedupe: one host per platform, no fragment, no tracking params, no trailing slash. */
export function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const platform = classify(u.href);
    u.hash = '';
    if (YOUTU_BE.test(u.hostname)) {
      u.searchParams.set('v', u.pathname.slice(1));
      u.pathname = '/watch';
    }
    if (REDD_IT.test(u.hostname)) u.pathname = `/comments${u.pathname}`;
    const host = CANONICAL_HOST[platform];
    if (host) {
      u.protocol = 'https:';
      u.hostname = host;
      const kept = KEPT_PARAMS[platform] ?? [];
      for (const k of [...u.searchParams.keys()]) if (!kept.includes(k)) u.searchParams.delete(k);
      const rule = POST_PATH[platform];
      const post = rule?.re.exec(u.pathname);
      if (rule && post) u.pathname = rule.path(post[1]!);
    } else {
      for (const k of [...u.searchParams.keys()]) if (/^(utm_|si$|igsh|ref_src$|fbclid$)/.test(k)) u.searchParams.delete(k);
    }
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Extracts links from content and Discord embeds. unfurledOnly excludes bot-written links without Discord previews. */
export function extractLinks(content: string, embeds: unknown, unfurledOnly = false): ExtractedLink[] {
  const byUrl = new Map<string, ExtractedLink>();
  const add = (raw: string, e?: RawEmbed): void => {
    const url = normalizeUrl(raw);
    if (!url || IGNORED_HOSTS.test(new URL(url).hostname)) return;
    const prev = byUrl.get(url);
    byUrl.set(url, {
      url,
      platform: classify(url),
      title: e?.title ?? prev?.title ?? null,
      description: e?.description ?? prev?.description ?? null,
      // Discord's media-proxy copy only: the app never fetches third-party hosts directly.
      thumbnailUrl: e?.thumbnail?.proxy_url ?? e?.image?.proxy_url ?? prev?.thumbnailUrl ?? null,
      site: e?.provider?.name ?? prev?.site ?? null,
    });
  };
  if (!unfurledOnly) for (const m of linkify.find(content, 'url')) add(m.href);
  if (Array.isArray(embeds)) for (const e of embeds as RawEmbed[]) if (e.url) add(e.url, e);
  return [...byUrl.values()];
}
