// Search rankers (docs/plugin-architecture.md §3): active plugins reorder full-text hits in build order; one that is off,
// fails or returns anything but a reordering leaves the order it was given, and a failure is recorded on its plugin.
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CorePlugin, type SearchRanker } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import type { SearchHit } from '@shared/contract';
import { PluginHost } from '../src/core/plugins/host';
import { rankSearch } from '../src/core/searchRankers';
import { tempDb, tempDir } from './helpers';

const ranking = (id: string) => definePlugin({ manifest: { id, name: id, version: '1', description: '' }, search: { ranker: true } });
const first = ranking('rankfirst');
const second = ranking('ranksecond');

const hit = (id: string): SearchHit => ({ messageId: id, channelId: 'c', channelName: 'c', authorName: 'a', ts: 1, snippet: `snippet ${id}`, mentions: {} });
const HITS: readonly SearchHit[] = ['a', 'b', 'c'].map(hit);
const ids = (hits: readonly SearchHit[] | null): string[] | null => hits?.map((h) => h.messageId) ?? null;
const reversed: SearchRanker = async (_query, hits) => [...hits].reverse();

/** `cores` under one host in build order, the first the one a test switches; disposed when the test ends. */
function host(...cores: CorePlugin[]) {
  const t = testPlugin(cores[0]!, { with: cores.slice(1) });
  onTestFinished(() => t.dispose());
  return t;
}

/** Starts the probes; each asks the ranker `rankers` holds under its id at call time, so a test can swap it. */
function start(rankers: Record<string, SearchRanker>) {
  const t = host(
    ...[first, second]
      .filter((p) => rankers[p.manifest.id])
      .map((p) => defineCorePlugin(p, (ctx) => ctx.search.rerank((query, hits) => rankers[p.manifest.id]!(query, hits)))),
  );
  return { t, error: (id: string) => t.status(id).error };
}

describe('search rankers', () => {
  it('reorder in build order, each given the previous order; the host keeps its own hits and takes only order and relevance', async () => {
    const seen: string[][] = [];
    start({
      rankfirst: async (_query, hits) => [...hits].reverse().map((h, i) => ({ ...h, snippet: 'rewritten', relevance: i ? undefined : 0.9 })),
      ranksecond: async (query, hits) => {
        seen.push(hits.map((h) => `${query}:${h.messageId}`));
        return [hits[1]!, hits[0]!, hits[2]!];
      },
    });
    const out = await rankSearch('plans', HITS);
    expect(seen).toEqual([['plans:c', 'plans:b', 'plans:a']]);
    expect(ids(out)).toEqual(['b', 'c', 'a']);
    expect(out!.map((h) => h.snippet)).toEqual(['snippet b', 'snippet c', 'snippet a']);
    expect(out!.find((h) => h.messageId === 'c')!.relevance).toBe(0.9);
    expect(HITS.every((h) => h.relevance === undefined)).toBe(true);
  });

  it('answer null, so the full-text order stands, with no active ranker or when none changed the order', async () => {
    expect(await rankSearch('plans', HITS)).toBeNull();
    const h = start({ rankfirst: async (_query, hits) => hits });
    expect(await rankSearch('plans', HITS)).toBeNull();
    expect(h.error('rankfirst')).toBeNull();
  });

  it('keep the order they were given when one throws, rejects or returns anything but a reordering, recording it', async () => {
    const rankers: Record<string, SearchRanker> = { rankfirst: reversed, ranksecond: reversed };
    const h = start(rankers);
    const bad: [SearchRanker, RegExp][] = [
      [() => { throw new Error('ranker threw'); }, /ranker threw/],
      [async () => Promise.reject(new Error('ranker rejected')), /ranker rejected/],
      [async (_q, hits) => hits.slice(1), /not a reordering/],
      [async (_q, hits) => [...hits, hit('x')], /not a reordering/],
      [async (_q, hits) => [hits[0]!, hits[0]!, hits[1]!], /not a reordering/],
      [async (_q, hits) => [...hits].reverse().map((h) => ({ ...h, messageId: `${h.messageId}!` })), /not a reordering/],
      [async (_q, hits) => hits.map((h) => ({ ...h, relevance: 2 })), /not a reordering/],
      [async (_q, hits) => hits.map((h) => ({ ...h, relevance: Number.NaN })), /not a reordering/],
      [async () => null as unknown as SearchHit[], /not a reordering/],
    ];
    for (const [ranker, error] of bad) {
      rankers['rankfirst'] = ranker;
      // The first fails; the second still reverses the full-text order it is given.
      expect(ids(await rankSearch('plans', HITS))).toEqual(['c', 'b', 'a']);
      expect(h.error('rankfirst')).toMatch(error);
    }
    expect(h.error('ranksecond')).toBeNull();
  });

  it('skip a turned-off ranker, and drop an answer that arrives after its plugin turned off, unrecorded', async () => {
    let answer!: (hits: SearchHit[]) => void;
    const h = start({ rankfirst: () => new Promise((resolve) => (answer = resolve)) });
    const pending = rankSearch('plans', HITS);
    await Promise.resolve();
    await h.t.off();
    answer([...HITS].reverse());
    expect(await pending).toBeNull();
    expect(await rankSearch('plans', HITS)).toBeNull();
    expect(h.error('rankfirst')).toBeNull();
  });

  it('drop the result when a ranker whose order was used turns off before the last one answers', async () => {
    let answer!: (hits: SearchHit[]) => void;
    const h = start({ rankfirst: reversed, ranksecond: (_q, hits) => new Promise((resolve) => (answer = () => resolve(hits))) });
    const pending = rankSearch('plans', HITS);
    await new Promise((resolve) => setTimeout(resolve));
    await h.t.off();
    answer([]);
    expect(await pending).toBeNull();
    expect(h.error('ranksecond')).toBeNull();
  });

  it('leave a list naming a message twice as it is', async () => {
    start({ rankfirst: reversed });
    expect(await rankSearch('plans', [hit('a'), hit('a'), hit('b')])).toBeNull();
  });
});

describe('a search ranker registration', () => {
  it('fails the activation when declared and never registered, and throws when undeclared or registered twice', () => {
    const missing = 'rankfirst declares but never registered: search ranker rerank';
    expect(host(defineCorePlugin(first, () => undefined)).status()).toEqual({ status: 'error', error: missing });
    const coreless = new PluginHost(tempDir(), { db: tempDb(), emit: () => undefined } as never, [], [first]);
    coreless.startBundled();
    expect(coreless.list()[0]).toMatchObject({ status: 'error', error: missing });

    const undeclared = definePlugin({ manifest: { id: 'noranker', name: 'n', version: '1', description: '' } });
    const refused: unknown[] = [];
    host(
      defineCorePlugin(undeclared, (ctx) => {
        try {
          ctx.search.rerank(reversed);
        } catch (err) {
          refused.push(err);
        }
      }),
      defineCorePlugin(second, (ctx) => {
        ctx.search.rerank(reversed);
        try {
          ctx.search.rerank(reversed);
        } catch (err) {
          refused.push(err);
        }
      }),
    );
    expect(refused.map(String)).toEqual(['Error: noranker declares no search ranker', 'Error: ranksecond registers one search ranker']);
  });
});
