// Scores the chooser without labels: half the Discord replies fit it, the other half are decided as if unmarked and compared with what they answered.
import type { ConversationSizes, LevelScore, LinkScore } from '@shared/conversationScore';
import type { Db } from '../db';
import type { Weights } from './chooser';
import { FEATURES } from './features';
import { fittedWeights, replySamples } from './fit';
import { LINK_BATCH } from './job';
import { CANDIDATE_MAX, LINK_MIN_CONFIDENCE, linkMessages } from './linker';
import { channelReach, contextInputs, linkInputs, threadStart } from './store';

/** The held-out half: an odd last digit. A snowflake's last digit follows neither time nor channel. */
export const isHeldOut = (id: string): boolean => Number(id.at(-1)) % 2 === 1;
/** A conversation this large is a runaway: under the earlier rules, two in five messages were in one. */
export const RUNAWAY_CONVERSATION = 200;
/** Confidence levels compared, from linking every message to its best candidate (0) to linking only sure picks. */
export const CONFIDENCE_LEVELS = [0, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8] as const;

/** Every message's best link (replies and threads at confidence 1), and each held-out reply's hidden pick. */
class Walk {
  readonly index = new Map<string, number>();
  readonly parent: number[] = [];
  readonly confidence: number[] = [];
  /** False for nodes only seen as a parent (in an unscored channel, or missing). */
  readonly archived: boolean[] = [];
  messages = 0;
  readonly held: { target: number; pick: number; confidence: number }[] = [];
  previousExact = 0;

  node(id: string): number {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.parent.length;
      this.index.set(id, i);
      this.parent.push(-1);
      this.confidence.push(0);
      this.archived.push(false);
    }
    return i;
  }
}

/** Scores `channelIds` (default: every archived channel), yielding between batches. */
export async function scoreReplyHoldout(db: Db, channelIds?: readonly string[], signal?: AbortSignal): Promise<LinkScore> {
  const samples = await replySamples(db, (id) => !isHeldOut(id), signal);
  const weights = fittedWeights(samples);
  const channels = channelIds ?? (db.prepare('SELECT DISTINCT channel_id FROM messages').pluck().all() as string[]);
  const walk = new Walk();
  for (const channelId of channels) await walkChannel(db, channelId, weights, walk, signal);
  const stored: Record<string, number> = {};
  for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM conversation_links GROUP BY kind').all() as { kind: string; n: number }[]) stored[row.kind] = row.n;
  return {
    replies: walk.held.length, previousExact: walk.previousExact, messages: walk.messages,
    minConfidence: LINK_MIN_CONFIDENCE, levels: CONFIDENCE_LEVELS.map((level) => scoreLevel(walk, level)),
    fit: { samples: samples.length, weights: Object.fromEntries(FEATURES.map((f, i) => [f, weights[i]!])) },
    stored, queuedChannels: db.prepare('SELECT COUNT(*) FROM conversation_link_queue').pluck().get() as number,
  };
}

async function walkChannel(db: Db, channelId: string, weights: Weights, walk: Walk, signal?: AbortSignal): Promise<void> {
  const reachMs = channelReach(db, channelId);
  const thread = threadStart(db, channelId);
  let cursor = { ts: Number.MIN_SAFE_INTEGER, id: '' };
  let context = contextInputs(db, channelId, cursor, reachMs, CANDIDATE_MAX);
  const seen = new Set<string>();
  for (;;) {
    signal?.throwIfAborted();
    const batch = linkInputs(db, channelId, cursor, Number.MAX_SAFE_INTEGER, LINK_BATCH);
    if (!batch.length) return;
    // Every message decided as if unmarked, keeping every best pick: a reply's own link is its mark.
    const picks = linkMessages(context, batch, { reachMs, weights, minConfidence: 0, ...(thread ? { thread } : {}) }, { hideReplies: true });
    batch.forEach((m, i) => {
      const self = walk.node(m.id);
      walk.archived[self] = true;
      walk.messages++;
      const pick = picks[i]!;
      const target = m.replyTo && m.replyTo !== m.id ? m.replyTo : null;
      const parentId = target ?? pick.parentId;
      if (parentId) {
        walk.parent[self] = walk.node(parentId);
        walk.confidence[self] = target ? 1 : pick.confidence;
      }
      const scored = target !== null && isHeldOut(m.id) && seen.has(target);
      seen.add(m.id);
      if (!scored) return;
      walk.held.push({ target: walk.node(target), pick: pick.parentId ? walk.node(pick.parentId) : -1, confidence: pick.confidence });
      const previous = i > 0 ? batch[i - 1] : context.at(-1);
      if (previous?.id === target) walk.previousExact++;
    });
    context = [...context, ...batch].slice(-CANDIDATE_MAX);
    cursor = { ts: batch.at(-1)!.ts, id: batch.at(-1)!.id };
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Conversations and reply recovery if inferred links below `level` were starts. */
function scoreLevel(walk: Walk, level: number): LevelScore {
  const n = walk.parent.length;
  const root = new Int32Array(n).fill(-1);
  const up = (i: number): number => (walk.parent[i]! >= 0 && walk.confidence[i]! >= level ? walk.parent[i]! : i);
  const find = (i: number): number => {
    const path: number[] = [];
    let j = i;
    while (root[j] === -1 && up(j) !== j) { path.push(j); j = up(j); }
    const r = root[j] === -1 ? j : root[j]!;
    root[j] = r;
    for (const p of path) root[p] = r;
    return r;
  };
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!walk.archived[i]) continue;
    const r = find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  let exact = 0;
  let sameConversation = 0;
  for (const h of walk.held) {
    if (h.pick < 0 || h.confidence < level) continue;
    if (h.pick === h.target) exact++;
    if (find(h.pick) === find(h.target)) sameConversation++;
  }
  return { minConfidence: level, exact, sameConversation, conversations: conversationSizes([...sizes.values()]) };
}

function conversationSizes(values: number[]): ConversationSizes {
  const sorted = values.sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return {
    count: sorted.length, median: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0,
    inRunaway: sorted.reduce((total, v) => total + (v >= RUNAWAY_CONVERSATION ? v : 0), 0),
  };
}
