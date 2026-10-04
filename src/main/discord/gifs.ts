// GIF search through Discord's own GIF endpoints (Klipy behind them), called as the live client's GIF picker calls them.
import type { Gif } from '@shared/compose';
import type { DiscordReader } from './client';
import type { HeaderCapture } from './capture';

/** Preview format asked for. Assumption: mp4 is what the live client's picker selects in Chromium. */
const GIF_MEDIA_FORMAT = 'mp4';
/** Results per search: a picker's worth, like the client's. */
const GIF_RESULTS_MAX = 50;
/** Locale when the client's X-Discord-Locale header hasn't been captured. */
const FALLBACK_LOCALE = 'en-US';

interface RawGif {
  id: string | number;
  url: string;
  src: string;
  width: number;
  height: number;
}

const clientLocale = (capture: HeaderCapture): string =>
  Object.entries(capture.current?.extra ?? {}).find(([k]) => k.toLowerCase() === 'x-discord-locale')?.[1] ?? FALLBACK_LOCALE;

/** GIFs matching `query`, or trending GIFs for an empty one. `query` comes from the renderer. */
export async function searchGifs(api: DiscordReader, capture: HeaderCapture, query: unknown): Promise<Gif[]> {
  if (typeof query !== 'string') throw new Error('Not a GIF search.');
  const q = query.trim();
  const params = { media_format: GIF_MEDIA_FORMAT, locale: clientLocale(capture), limit: GIF_RESULTS_MAX };
  const raw = await api.get<unknown>(q ? 'gifs/search' : 'gifs/trending-gifs', q ? { q, ...params } : params);
  if (!Array.isArray(raw)) throw new Error('Discord sent an unexpected GIF list.');
  return (raw as RawGif[]).map((g) => ({ id: String(g.id), url: g.url, src: g.src, width: g.width, height: g.height }));
}
