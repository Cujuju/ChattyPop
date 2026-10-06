// What the composer's pickers offer: every server's emoji and stickers and Discord's sticker packs (main, from the live
// client), Unicode emoji (emojibase, loaded on first use) and GIF search.
import { api } from '@/api';
import { createResource, createSignal, untrack } from 'solid-js';
import { canUseEmoji, type ExpressionCatalog, type Gif } from '@shared/compose';
import type { GuildEmoji } from '@shared/emoji';
import { onAppEvent } from './events';

/** Each picker opening asks again (a new object), so emoji added since show up; main answers from memory. */
const [catalogRequest, setCatalogRequest] = createSignal<{ guildId: string } | null>(null);
export const [expressionCatalog] = createResource(catalogRequest, (r) => api.discord.expressions(r.guildId));
/** Emoji in the "Frequently used" row: two picker rows' worth, as Discord shows. */
const FREQUENT_EMOJI_MAX = 22;
/** Refreshes frequently used emoji with catalog reloads, including just-sent messages. Excludes Unicode glyphs unavailable on this machine. */
export const [frequentEmoji, { refetch: refetchFrequentEmoji }] = createResource(catalogRequest, async () =>
  (await api.core.ownEmoji(FREQUENT_EMOJI_MAX)).filter((e) => !('unicode' in e) || canDraw(e.unicode)),
);
// Counted over visible messages only: a server hidden since must not keep its emoji in the row.
onAppEvent('privacy-changed', () => void (untrack(catalogRequest) && refetchFrequentEmoji()));
/** Returns undefined for failed resources to avoid Solid latest rethrowing across sibling sections. Each section displays its own error. */
export const loaded = <T,>(r: { error: unknown; latest: T | undefined }): T | undefined => (r.error ? undefined : r.latest);

/** Loads (or refreshes) the pickers' catalog for a channel of `guildId`. */
export const loadExpressions = (guildId: string): void => void setCatalogRequest({ guildId });
/** Loads the catalog for `guildId` unless it was last asked for that server: for views drawn often (a hover bar). */
export const ensureExpressions = (guildId: string): void => {
  if (untrack(catalogRequest)?.guildId !== guildId) loadExpressions(guildId);
};

export const searchGifs = (query: string): Promise<Gif[]> => api.discord.gifs(query);

export interface UnicodeEmoji {
  emoji: string;
  label: string;
  /** Discord-style names (joypixels shortcodes), first one shown. */
  shortcodes: string[];
  /** Lower-case words searched: label, tags and shortcodes. */
  search: string;
}

export interface UnicodeGroup {
  name: string;
  emojis: UnicodeEmoji[];
}

/** The emojibase fields read (its CompactEmoji). */
interface RawEmoji {
  unicode: string;
  label: string;
  hexcode: string;
  group?: number;
  order?: number;
  tags?: string[];
}
interface RawGroups {
  groups: { key: string; message: string; order: number }[];
}

/** Skin-tone swatches and hair parts: pieces of other emoji, which Discord's picker doesn't list. */
const COMPONENT_GROUP_KEY = 'component';
/** Canvas size an emoji is drawn at to test it; large enough to see colour, small enough to read back quickly. */
const PROBE_PX = 24;
/** Wider than this many single emoji: the font drew a sequence as its separate parts. */
const MAX_GLYPH_WIDTHS = 1.5;
/** Emoji tested per task: drawing one costs ~0.25 ms (measured on Windows 10), so ~25 ms, then the UI gets a turn. */
const PROBES_PER_TASK = 100;

/** Checks single-glyph emoji font support. Excludes unavailable/newer emoji that render as boxes or separate parts. */
function drawableTest(): (emoji: string) => boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PROBE_PX * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return () => true;
  ctx.font = `${PROBE_PX}px ${getComputedStyle(document.documentElement).getPropertyValue('--cp-font-sans')}`;
  ctx.textBaseline = 'top';
  const draw = (text: string): Uint8ClampedArray => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(text, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const oneGlyph = ctx.measureText('😀').width;
  // No font has a glyph for a noncharacter: this is how a missing glyph looks.
  const missing = draw('\u{10FFFF}');
  return (emoji) => ctx.measureText(emoji).width <= oneGlyph * MAX_GLYPH_WIDTHS && draw(emoji).some((v, i) => v !== missing[i]);
}

let drawable: ((emoji: string) => boolean) | undefined;
/** drawableTest, made once: the font doesn't change while the app runs. */
export const canDraw = (emoji: string): boolean => (drawable ??= drawableTest())(emoji);

async function loadUnicodeEmoji(): Promise<UnicodeGroup[]> {
  const [data, shortcodes, messages] = await Promise.all([
    import('emojibase-data/en/compact.json').then((m) => m.default as unknown as RawEmoji[]),
    import('emojibase-data/en/shortcodes/joypixels.json').then((m) => m.default as unknown as Record<string, string | string[]>),
    import('emojibase-data/en/messages.json').then((m) => m.default as unknown as RawGroups),
  ]);
  const groups = [...messages.groups].sort((a, b) => a.order - b.order).filter((g) => g.key !== COMPONENT_GROUP_KEY);
  const byGroup = new Map<number, UnicodeEmoji[]>(groups.map((g) => [g.order, []]));
  const sorted = [...data].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const [i, e] of sorted.entries()) {
    if (i % PROBES_PER_TASK === 0) await new Promise((r) => setTimeout(r));
    const list = e.group === undefined ? undefined : byGroup.get(e.group);
    if (!list || !canDraw(e.unicode)) continue;
    const codes = [shortcodes[e.hexcode] ?? []].flat();
    list.push({ emoji: e.unicode, label: e.label, shortcodes: codes, search: [e.label, ...(e.tags ?? []), ...codes].join(' ').toLowerCase() });
  }
  return groups.map((g) => ({ name: g.message, emojis: byGroup.get(g.order)! })).filter((g) => g.emojis.length);
}

const [unicodeWanted, setUnicodeWanted] = createSignal(false);
/** Unicode emoji by group, loaded the first time the emoji picker opens. */
export const [unicodeEmoji] = createResource(unicodeWanted, loadUnicodeEmoji);
export const loadUnicodeEmojiData = (): void => void setUnicodeWanted(true);

/** A `:name` suggestion while typing: a custom emoji the plan can send here, or a Unicode emoji by its shortcode. */
export type EmojiSuggestion = { custom: GuildEmoji; name: string } | { unicode: string; name: string };

/** Letters typed after a colon before suggestions show, as in Discord. */
export const EMOJI_SUGGEST_MIN_CHARS = 2;
/** Suggestions listed; typing more narrows them. */
const EMOJI_SUGGESTIONS_MAX = 10;

/** Colon search ranks prefix matches, frequency, custom then Unicode. Custom emoji must be sendable in guildId. */
export function emojiSuggestions(guildId: string, query: string): EmojiSuggestion[] {
  const q = query.toLowerCase();
  const catalog = loaded(expressionCatalog);
  const custom: EmojiSuggestion[] = (catalog?.emojis ?? [])
    .filter((e) => e.name.toLowerCase().includes(q) && canUseEmoji(e, guildId, catalog!.perks))
    .map((e) => ({ custom: e, name: e.name }));
  const unicode: EmojiSuggestion[] = (loaded(unicodeEmoji) ?? []).flatMap((g) =>
    g.emojis.flatMap((e) => {
      const name = e.shortcodes.find((s) => s.includes(q));
      return name ? [{ unicode: e.emoji, name }] : [];
    }),
  );
  const used = (loaded(frequentEmoji) ?? []).map((f) => ('unicode' in f ? f.unicode : f.custom.id));
  const rank = (s: EmojiSuggestion): number => {
    const at = used.indexOf('custom' in s ? s.custom.id : s.unicode);
    return at < 0 ? used.length : at;
  };
  const starts = (s: EmojiSuggestion): number => Number(!s.name.toLowerCase().startsWith(q));
  // A stable sort keeps custom ahead of Unicode among equals.
  return [...custom, ...unicode].sort((a, b) => starts(a) - starts(b) || rank(a) - rank(b)).slice(0, EMOJI_SUGGESTIONS_MAX);
}