// Per-channel stash: drafts set aside (text, files, picked tokens, reply) to write another message, newest first.
// Kept in IndexedDB like the drafts, so a stash survives reloads and quits.
import { createStore } from '@plugin-sdk/renderer/containment';
import { unwrap } from 'solid-js/store';
import { idbEntries, idbSet } from '@/ui/idbStore';
import { isDraftEmpty, restoreDraft, takeDraft, type SavedDraft } from './drafts';
import { cancelReply, replyTarget } from './reply';

const STASH_KEY = 'draft-stash:';

const [stashes, setStashes] = createStore<Record<string, SavedDraft[]>>({});
/** Channels whose stash was saved this session: their stored copy no longer holds the older stashes. */
const stashSaved = new Set<string>();

/** The channel's stashed drafts, newest first. */
export const stashedDrafts = (channelId: string): readonly SavedDraft[] => stashes[channelId] ?? [];

function saveStash(channelId: string, list: SavedDraft[]): void {
  stashSaved.add(channelId);
  setStashes(channelId, list);
  // Unwrapped: IndexedDB can't clone a store proxy.
  idbSet(STASH_KEY + channelId, list.length ? list.map((d) => unwrap(d)) : undefined);
}

/** Empties the channel's draft and returns it with the reply it carries; the reply bar closes. */
function takeWithReply(channelId: string): SavedDraft {
  const t = replyTarget();
  const reply = t && t.channelId === channelId ? unwrap(t) : null;
  const taken = takeDraft(channelId, reply);
  if (reply) cancelReply();
  return taken;
}

/** Sets the channel's draft aside, leaving the box empty; false when there is nothing to stash. */
export function stashDraft(channelId: string): boolean {
  if (isDraftEmpty(channelId)) return false;
  saveStash(channelId, [takeWithReply(channelId), ...stashedDrafts(channelId)]);
  return true;
}

/** Brings stashed draft `index` back into the box; a draft already there takes its place in the stash. */
export function unstashDraft(channelId: string, index: number): void {
  const list = stashedDrafts(channelId);
  const chosen = list[index];
  if (!chosen) return;
  const rest = list.filter((_, i) => i !== index);
  const current = isDraftEmpty(channelId) ? [] : [takeWithReply(channelId)];
  // The reply is one across channels; the stashed one replaces whatever reply is open.
  if (chosen.reply) cancelReply();
  restoreDraft(channelId, unwrap(chosen));
  saveStash(channelId, [...current, ...rest]);
}

/** Throws stashed draft `index` away; the box is untouched. */
export function dropStashedDraft(channelId: string, index: number): void {
  const list = stashedDrafts(channelId);
  if (!list[index]) return;
  saveStash(channelId, list.filter((_, i) => i !== index));
}

// Brings back the stashes kept before a reload, after any stashed meanwhile (whose save left the older ones out).
void idbEntries<SavedDraft[]>(STASH_KEY).then((saved) => {
  for (const [key, older] of saved) {
    const channelId = key.slice(STASH_KEY.length);
    const merged = [...stashedDrafts(channelId), ...older];
    if (stashSaved.has(channelId)) saveStash(channelId, merged);
    else setStashes(channelId, merged);
  }
});
