// Search re-rank: Jev orders the top full-text search results by how well they answer the query.
import { definePlugin, type JevQueryDecl } from '@plugin-sdk/shared';

export const manifest = {
  id: 'rerank',
  name: 'Search re-rank',
  version: '1.0.0',
  description: 'Jev re-orders the top search results by how well they answer your query.',
};

/** Settings → Jev → Queries id (kept from when it was built in, so the owner's edits still apply); {ref} is a candidate's key. */
export const RERANK_QUERY = 'search.rerank';

const RERANK_QUERY_DEF: JevQueryDecl<'searchRerank'> = {
  id: RERANK_QUERY,
  // Where it was listed when it was built in: after Links' queries, ahead of the host's channel suggestion.
  after: 'links.worth',
  group: 'Links & search',
  label: 'Search result relevance',
  features: ['searchRerank'],
  sees: '`query` (your search) and `candidates` (the top results, author in #channel: text).',
  placeholders: ['{ref}'],
  use: 'rank',
  condition: null,
  defaults: {
    type: 'noul',
    question: 'Does candidate {ref} answer `query` or directly address what it asks about?',
    yes: 'answers or directly addresses the query',
    no: 'only shares words with it',
    minProbability: 0.5,
  },
};

export const plugin = definePlugin({
  manifest,
  search: { ranker: true },
  // Its switch kept its key from when it was built in; its row keeps its place in Settings → Jev.
  adopts: { jevFeatures: { searchRerank: 'searchRerank' } },
  jev: { queries: [RERANK_QUERY_DEF], features: [{ key: 'searchRerank', label: 'Re-rank search by meaning', default: false, after: 'keepImportant' }] },
});
export default plugin;
