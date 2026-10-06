// Active plugin rankers reorder displayed full-text hits. Disabled, failed or invalid rankers leave order unchanged.
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

/** Returns original hits reordered by message id with validated probability relevance. Invalid reorderings return null; other supplied fields are ignored. */
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

/** Runs rankers on copied hits with lifetime fences. Records throws, rejections and invalid reorderings; late answers are discarded. */
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

/** Chains active rankers in build order. Returns null for unchanged results, duplicate ids or an earlier contributing ranker disabled before completion. */
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
