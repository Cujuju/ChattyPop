// The one-tap reactions a message's hover bar and menu offer: the owner's most-used reactions that work in its channel.
import { canUseEmoji } from '@shared/compose';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById } from './directory';
import { canDraw, ensureExpressions, expressionCatalog, frequentEmoji, loaded } from './expressions';
import { asReaction, ownReactions, wantOwnReactions } from './reactions';

/** Fill the row until the owner has used that many of their own (a new archive has few). */
const DEFAULT_QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const guildOf = (m: ArchiveMessage): string => channelById(m.channelId)?.guildId ?? DM_GUILD_ID;

/** Loads what quickReactions reads for `m`, once: call when a view offering them opens, not while drawing. */
export function prepareQuickReactions(m: ArchiveMessage): void {
  wantOwnReactions();
  ensureExpressions(guildOf(m));
}

const sameEmoji = (a: ArchiveEmoji, b: ArchiveEmoji): boolean => (a.id ? a.id === b.id : !b.id && a.name === b.name);

/** Quick reactions prefer owner reactions, then emoji, then defaults. Custom choices require catalog/plan eligibility; Unicode choices require local glyph support. */
export function quickReactions(m: ArchiveMessage, count: number): ArchiveEmoji[] {
  const guildId = guildOf(m);
  const catalog = loaded(expressionCatalog);
  const byId = new Map((catalog?.emojis ?? []).map((e) => [e.id, e]));
  const usable = (e: ArchiveEmoji): boolean => {
    // Exclude unsupported local emoji glyphs.
    if (!e.id) return canDraw(e.name);
    const g = byId.get(e.id);
    return Boolean(g && catalog && canUseEmoji(g, guildId, catalog.perks));
  };
  const ranked = [
    ...(loaded(ownReactions) ?? []),
    ...(loaded(frequentEmoji) ?? []).map(asReaction),
    ...DEFAULT_QUICK_REACTIONS.map((unicode) => asReaction({ unicode })),
  ];
  const out: ArchiveEmoji[] = [];
  for (const e of ranked) {
    if (out.length === count) break;
    if (usable(e) && !out.some((o) => sameEmoji(o, e))) out.push(e);
  }
  return out;
}
