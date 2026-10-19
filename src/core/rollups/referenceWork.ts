import type { ArchiveRead } from '../plugins/pluginDb';

export interface ReferenceRow { kind: string; id: string | number; channel_id: string; day: string; text: string; referenced: number }
export interface ReferenceWork { sql: string; bootstrap: number }

/** One substring automaton per worker snapshot replaces messages × catalog SQL scans. */
export async function referenceWork(_part: unknown, read: ArchiveRead, signal: AbortSignal, data: ReferenceWork): Promise<ReferenceRow[]> {
  const ids = await read<{ id: string }>('SELECT id FROM channels UNION SELECT id FROM guilds');
  const nodes: { edges: Map<string, number>; fail: number; match: boolean }[] = [{ edges: new Map(), fail: 0, match: false }];
  for (const { id } of ids) {
    let state = 0;
    for (const char of id) {
      let next = nodes[state]!.edges.get(char);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.edges.set(char, next);
        nodes.push({ edges: new Map(), fail: 0, match: false });
      }
      state = next;
    }
    nodes[state]!.match = true;
  }
  const queue = [...nodes[0]!.edges.values()];
  for (let offset = 0; offset < queue.length; offset++) {
    const state = queue[offset]!;
    for (const [char, next] of nodes[state]!.edges) {
      let fallback = nodes[state]!.fail;
      while (fallback && !nodes[fallback]!.edges.has(char)) fallback = nodes[fallback]!.fail;
      nodes[next]!.fail = nodes[fallback]!.edges.get(char) ?? 0;
      nodes[next]!.match ||= nodes[nodes[next]!.fail]!.match;
      queue.push(next);
    }
  }
  const matches = (text: string): boolean => {
    let state = 0;
    if (nodes[0]!.match) return true;
    for (const char of text) {
      while (state && !nodes[state]!.edges.has(char)) state = nodes[state]!.fail;
      state = nodes[state]!.edges.get(char) ?? 0;
      if (nodes[state]!.match) return true;
    }
    return false;
  };
  const rows = await read<ReferenceRow & { indexed: number }>(data.sql, { bootstrap: data.bootstrap });
  return rows.flatMap((row) => {
    signal.throwIfAborted();
    const referenced = Number(matches(row.text ?? ''));
    return referenced === row.indexed ? [] : [{ kind: row.kind, id: row.id, channel_id: row.channel_id, day: row.day, text: row.text, referenced }];
  });
}
