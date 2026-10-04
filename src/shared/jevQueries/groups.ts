// Settings → Jev → Queries' groups, in order. Apart from the query catalog, so descriptor checks read it without the registry.
export type JevQueryGroup = 'Alerts' | 'Messages' | 'Summaries' | 'Links & search' | 'Jev check';
export const JEV_QUERY_GROUPS: readonly JevQueryGroup[] = ['Alerts', 'Messages', 'Summaries', 'Links & search', 'Jev check'];
