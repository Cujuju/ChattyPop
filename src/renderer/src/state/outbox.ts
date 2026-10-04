// The app's outbox (see outboxQueue.ts). Each page keeps its queue in IndexedDB under its own key; a page that starts
// takes over the queues of pages that are gone (itself before a reload, a closed app) and sends them on, once posting
// unlocks (state/posting.ts).
import { createEffect, createRoot } from 'solid-js';
import { api } from '@/api';
import { newNonce } from '@shared/discord';
import { DESKTOP_CONNECTED_EVENT, DesktopUnreachableError } from '@shared/phone';
import { isPostingLocked } from '@shared/posting';
import { errorText } from '@/ui/format';
import { idbEntries, idbSet, whenWritten } from '@/ui/idbStore';
import { restoreDraft, type SavedDraft } from './drafts';
import { createOutbox, type OutboxRecord } from './outboxQueue';
import { postingUnlocked } from './posting';

export type { Outgoing } from './outboxQueue';

/** Saved queues, one per page: `outbox:<page id>`. */
const KEY_PREFIX = 'outbox:';
/** Held by each page while it lives; a saved queue whose page holds none is left over. */
const LIVE_LOCK_PREFIX = 'chattypop-outbox-live:';
/** One page at a time takes left-over queues, so two never send the same one. */
const CLAIM_LOCK = 'chattypop-outbox-claim';
/** Unique per page load (crypto.randomUUID needs a secure context; a snowflake doesn't). */
const pageId = newNonce();
const ownKey = KEY_PREFIX + pageId;

const box = createOutbox<SavedDraft>({
  send: (m) => api.discord.send(m),
  errorText,
  unreachable: (err) => err instanceof DesktopUnreachableError,
  restore: restoreDraft,
  save: (records) => idbSet(ownKey, records.length ? records : undefined),
  now: Date.now,
  unlocked: postingUnlocked,
  locked: isPostingLocked,
});
export const { outgoing, sendingDismissed, dismissSending, enqueue, retrySend, editSend, discardSend } = box;

type SavedQueue = [key: string, records: OutboxRecord<SavedDraft>[]];

/** Sends `queues` from this page; its own save lands before theirs are removed, so a reload between loses none. */
function adopt(queues: SavedQueue[]): void {
  if (!queues.length) return;
  box.load(queues.flatMap(([, records]) => records));
  for (const [key] of queues) idbSet(key, undefined);
}

async function adoptLeftovers(): Promise<void> {
  const locks = navigator.locks as LockManager | undefined;
  // Web Locks need a secure context (https, localhost). Without them every page takes every saved queue: two pages open
  // at once over plain http could both send one (Discord's nonce dedupe covers a few minutes).
  if (!locks) return adopt((await idbEntries<OutboxRecord<SavedDraft>[]>(KEY_PREFIX)).filter(([key]) => key !== ownKey));
  await new Promise<void>((held) => void locks.request(LIVE_LOCK_PREFIX + pageId, () => (held(), new Promise<never>(() => {}))));
  await locks.request(CLAIM_LOCK, async () => {
    const live = new Set((await locks.query()).held?.map((l) => l.name));
    const saved = await idbEntries<OutboxRecord<SavedDraft>[]>(KEY_PREFIX);
    adopt(saved.filter(([key]) => key !== ownKey && !live.has(LIVE_LOCK_PREFIX + key.slice(KEY_PREFIX.length))));
    await whenWritten();
  });
}
// Nothing is sent while posting is locked: left-over queues are taken over once it first unlocks (once per page, since
// the page's live lock is held for good), and each relock suspends the queue until the next unlock.
let adopted = false;
createRoot(() =>
  createEffect(() => {
    if (!postingUnlocked()) return box.suspend();
    if (!adopted) {
      adopted = true;
      void adoptLeftovers();
    }
    box.resume();
  }),
);

// Back online, or the phone's event stream reconnected: what couldn't reach the desktop goes again (not while locked).
window.addEventListener('online', box.retryUnreachable);
window.addEventListener(DESKTOP_CONNECTED_EVENT, box.retryUnreachable);
