import { parseRawJson, type Db } from './db';

/** A MESSAGE_REACTION_* gateway payload (the fields read here). */
export interface ReactionEvent {
  channel_id: string;
  message_id: string;
  emoji?: { id?: string | null; name?: string | null; animated?: boolean };
  /** Who reacted (ADD and REMOVE). */
  user_id?: string;
  /** A super reaction: counted, but `me` tracks only the owner's normal reaction. */
  burst?: boolean;
}

/** A reaction as REST returns it; `me` is whether the signed-in user added it. */
interface StoredReaction {
  emoji: { id?: string | null; name?: string | null; animated?: boolean };
  count: number;
  me?: boolean;
}

/**
 * Keeps a stored message's reaction snapshot current from gateway reaction events (raw_json.reactions, as REST returns it).
 * Only counts and the owner's own `me` are tracked; who else reacted isn't kept. The owner's normal reaction arrives twice
 * (the gateway, and main after its own request), so one that already matches `me` changes nothing.
 * Returns whether the message changed.
 */
export function applyReactionEvent(db: Db, t: string, d: ReactionEvent, selfId: string | null): boolean {
  const row = db.prepare('SELECT raw_json FROM messages WHERE id = ?').get(d.message_id) as { raw_json: string | Buffer | null } | undefined;
  const msg = parseRawJson<{ reactions?: StoredReaction[] }>(row?.raw_json ?? null);
  if (!msg) return false;
  const same = (e?: { id?: string | null; name?: string | null }): boolean =>
    Boolean(e && d.emoji && (d.emoji.id ? e.id === d.emoji.id : !e.id && e.name === d.emoji.name));
  let reactions = msg.reactions ?? [];
  if (t === 'MESSAGE_REACTION_REMOVE_ALL') reactions = [];
  else if (t === 'MESSAGE_REACTION_REMOVE_EMOJI') reactions = reactions.filter((r) => !same(r.emoji));
  else {
    const adding = t === 'MESSAGE_REACTION_ADD';
    const own = selfId !== null && d.user_id === selfId && !d.burst;
    const hit = reactions.find((r) => same(r.emoji));
    if (own && (hit?.me === true) === adding) return false;
    if (hit) {
      hit.count += adding ? 1 : -1;
      if (own) hit.me = adding;
    } else if (adding && d.emoji) reactions.push({ emoji: { id: d.emoji.id ?? null, name: d.emoji.name ?? null, animated: Boolean(d.emoji.animated) }, count: 1, me: own });
    reactions = reactions.filter((r) => r.count > 0);
  }
  msg.reactions = reactions;
  db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(JSON.stringify(msg), d.message_id);
  return true;
}
