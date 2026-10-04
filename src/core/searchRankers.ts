// Search rankers (docs/plugin-architecture.md §3): active plugins reorder full-text hits after windows show them. A ranker
// that is off, fails or returns anything but a reordering of what it was given leaves that order in place.
import type { SearchHit } from '@shared/contract';
import { isObj } from '@shared/normalize';
import { PluginInactiveError } from '@shared/pluginCall';

/** A plugin's ranker (ctx.search.rerank): `query` is the search's free text, filter tokens removed; resolves with `hits` reordered. */
export type SearchRanker = (query: string, hits: SearchHit[]) => Promise<SearchHit[]>;

/** A ranker as the host runs it: its reordering, or null when it is off, failed or changed nothing it may. */
type HostRanker = (query: string, hits: readonly SearchHit[]) => Promise<SearchHit[] | null>;

interface Entry {
  /** Its plugin's place in the build list: rankers run in build order. */
  order: number;
  rank: HostRanker;
  /** Its plugin's activation is running: an ordering it gave counts only while it is. */
  live: () => boolean;
}
const rankers: Entry[] = [];

/** Registers a ranker at `order`, live while `live()`, and returns an identity-safe disposer. */
export function registerSearchRanker(order: number, rank: HostRanker, live: () => boolean): () => void {
  const entry: Entry = { order, rank, live };
  rankers.push(entry);
  rankers.sort((a, b) => a.order - b.order);
  return () => {
    const at = rankers.indexOf(entry);
    if (at >= 0) rankers.splice(at, 1);
  };
}

/** Unset, or a probability, as SearchHit.relevance holds. */
const isRelevance = (v: unknown): boolean => v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);

/**
 * `given`'s own hits in `ranked`'s order, each taking `ranked`'s relevance when it sets one; null when `ranked` isn't a
 * reordering of `given` (by message id) or a relevance isn't a probability. The ranker's other fields are ignored.
 */
export function reorderingOf(given: readonly SearchHit[], ranked: unknown): SearchHit[] | null {
  if (!Array.isArray(ranked) || ranked.length !== given.length) return null;
  const left = new Map(given.map((h) => [h.messageId, h]));
  const out: SearchHit[] = [];
  for (const r of ranked as unknown[]) {
    if (!isObj(r) || typeof r['messageId'] !== 'string' || !isRelevance(r['relevance'])) return null;
    const hit = left.get(r['messageId']);
    if (!hit) return null;
    left.delete(hit.messageId);
    const relevance = r['relevance'] as number | undefined;
    out.push(relevance === undefined ? hit : { ...hit, relevance });
  }
  return out;
}

/**
 * `rank` as the host runs it: nothing once `live()` ends, and an answer arriving after is dropped (`fence`). A throw, a
 * rejection or a result that isn't a reordering is recorded with `fail`. It gets copies, so it can't change the host's hits.
 */
export const hostRanker =
  (rank: SearchRanker, live: () => boolean, fence: <T>(work: Promise<T>) => Promise<T>, fail: (err: unknown) => void): HostRanker =>
  async (query, hits) => {
    if (!live()) return null;
    try {
      const ranked = reorderingOf(hits, await fence(Promise.resolve().then(() => rank(query, structuredClone([...hits])))));
      if (!ranked) throw new Error('Its search ranker returned a list that is not a reordering of the hits it was given.');
      return ranked;
    } catch (err) {
      if (!(err instanceof PluginInactiveError)) fail(err);
      return null;
    }
  };

/** Same hits in the same order with the same relevance. */
const sameRanking = (a: readonly SearchHit[], b: readonly SearchHit[]): boolean =>
  a.length === b.length && a.every((h, i) => h.messageId === b[i]!.messageId && h.relevance === b[i]!.relevance);

/**
 * `hits` through each active ranker in build order, each given the previous one's order; null when none changed it, so
 * the full-text order stands. Also null when a ranker whose order was used turned off before the last one answered:
 * later orders build on it, so none can stand without it. A list naming a message twice isn't one a ranker can reorder.
 */
export async function rankSearch(query: string, hits: readonly SearchHit[]): Promise<SearchHit[] | null> {
  if (new Set(hits.map((h) => h.messageId)).size !== hits.length) return null;
  let current = hits;
  const used: Entry[] = [];
  for (const entry of [...rankers]) {
    const ranked = await entry.rank(query, current);
    if (!ranked) continue;
    current = ranked;
    used.push(entry);
  }
  return sameRanking(hits, current) || !used.every((e) => e.live()) ? null : [...current];
}
