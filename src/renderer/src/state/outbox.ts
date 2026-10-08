// Each page persists its outbox in IndexedDB. On unlock, adopts queues from departed pages, including pre-reload owners.
import { createEffect, createRoot } from 'solid-js';
import { api } from '@/api';
import { POST_WINDOW_PASSED, UPLOAD_CHUNK_BYTES, UPLOAD_GONE } from '@shared/compose';
import { newNonce } from '@shared/discord';
import { DESKTOP_CONNECTED_EVENT, DesktopUnreachableError } from '@shared/phone';
import { isPostingLocked } from '@shared/posting';
import { errorText } from '@/ui/format';
import { idbEntries, idbGet, idbSet, whenWritten } from '@/ui/idbStore';
import { restoreDraft, type SavedDraft } from './drafts';
import { savedDraftFile, type DraftFileInput, type SavedDraftFile } from './draftFiles';
import { MS_PER_S } from '@shared/units';
import { SEND_BASE_TIMEOUT_MS, createOutbox, type OutboxRecord } from './outboxQueue';
import { postingUnlocked } from './posting';
import { prepareFiles } from './uploadPrep';
import { sentRows } from './outboxSent';
import { markSend, markSendPaint } from './outboxTiming';

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
/** Each message's files, stored once by its nonce: queue saves rewrite records often, and files can be gigabytes. */
const FILES_PREFIX = 'outbox-files:';
/** Nonces whose files this page has stored. */
const keptFiles = new Set<string>();

/** Saves the queue's records without their files; each message's files are written once and removed with it. */
function saveQueue(records: OutboxRecord<SavedDraft>[]): void {
  const live = new Set(records.map((r) => r.message.nonce));
  for (const r of records) {
    if (!r.files.length || keptFiles.has(r.message.nonce)) continue;
    keptFiles.add(r.message.nonce);
    idbSet(FILES_PREFIX + r.message.nonce, r.files);
  }
  for (const nonce of keptFiles) {
    if (live.has(nonce)) continue;
    keptFiles.delete(nonce);
    idbSet(FILES_PREFIX + nonce, undefined);
  }
  // The draft holds the same files (for Edit): stripped too, and given back from the message's on load.
  idbSet(ownKey, records.length ? records.map((r) => ({ ...r, files: [], draft: r.draft && { ...r.draft, files: [] } })) : undefined);
}

/** Saved records with their files read back; this page now keeps those files. */
async function withFiles(records: OutboxRecord<SavedDraft>[]): Promise<OutboxRecord<SavedDraft>[]> {
  return Promise.all(
    records.map(async (r) => {
      const files = ((await idbGet<DraftFileInput[]>(FILES_PREFIX + r.message.nonce)) ?? r.files ?? []).map(savedDraftFile);
      if (files.length) keptFiles.add(r.message.nonce);
      return { ...r, files, draft: r.draft && { ...r.draft, files } };
    }),
  );
}

/** A slow phone uplink (~2 Mbit/s); a piece slower than this counts as stalled. */
const MIN_UPLOAD_BYTES_PER_S = 256 * 1024;
/** How long one upload piece may take before the desktop counts as unreachable. */
const PIECE_TIMEOUT_MS = SEND_BASE_TIMEOUT_MS + (UPLOAD_CHUNK_BYTES / MIN_UPLOAD_BYTES_PER_S) * MS_PER_S;

/** `call`, or DesktopUnreachableError once `ms` passes: a stalled piece can't be told from a lost one. */
function unstalled<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new DesktopUnreachableError()), ms)));
  return Promise.race([call, stalled]).finally(() => clearTimeout(timer));
}

/** Uploads each file to its Discord slot in UPLOAD_CHUNK_BYTES pieces, read as they go; resolves the slots' tokens. */
async function uploadFiles(channelId: string, files: SavedDraftFile[], progress: (fraction: number) => void): Promise<string[]> {
  const slots = await unstalled(
    api.discord.prepareUploads(channelId, files.map((f) => ({ name: f.file.name, size: f.file.size, description: f.description, spoiler: f.spoiler }))),
    SEND_BASE_TIMEOUT_MS,
  );
  const total = files.reduce((n, f) => n + f.file.size, 0);
  let sent = 0;
  for (const [i, slot] of slots.entries()) {
    const file = files[i]!.file;
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
      await unstalled(api.discord.uploadChunk(slot.token, offset, bytes), PIECE_TIMEOUT_MS);
      sent += bytes.length;
      progress(total ? sent / total : 1);
    }
    await unstalled(api.discord.finishUpload(slot.token), SEND_BASE_TIMEOUT_MS);
  }
  return slots.map((s) => s.token);
}

const box = createOutbox<SavedDraft>({
  send: (m) => api.discord.send(m),
  accept: sentRows.accept,
  mark: (phase, nonce, id, messageId) => {
    if (phase === 'accepted') {
      if (messageId) markSendPaint('sent-row-painted', nonce, messageId);
      return;
    }
    markSend(phase, nonce);
    if (phase === 'enqueue') markSendPaint('pending-painted', nonce, `pending-${id}`);
  },
  prepare: async (channelId, files, progress) => prepareFiles(files, await unstalled(api.discord.uploadLimit(channelId), SEND_BASE_TIMEOUT_MS), progress),
  upload: uploadFiles,
  uploadGone: (err) => err instanceof Error && err.message.includes(UPLOAD_GONE),
  windowPassed: (err) => err instanceof Error && err.message.includes(POST_WINDOW_PASSED),
  errorText,
  unreachable: (err) => err instanceof DesktopUnreachableError,
  restore: restoreDraft,
  save: saveQueue,
  now: Date.now,
  unlocked: postingUnlocked,
  locked: isPostingLocked,
});
export const outgoing = (channelId: string) => box.outgoing(channelId).filter((m) => !sentRows.hasArchived(m.nonce));
export const { sendingDismissed, dismissSending, enqueue, retrySend, editSend, discardSend } = box;

type SavedQueue = [key: string, records: OutboxRecord<SavedDraft>[]];

/** Sends `queues` from this page; its own save lands before theirs are removed, so a reload between loses none. */
async function adopt(queues: SavedQueue[]): Promise<void> {
  if (!queues.length) return;
  box.load(await withFiles(queues.flatMap(([, records]) => records)));
  for (const [key] of queues) idbSet(key, undefined);
}

async function adoptLeftovers(): Promise<void> {
  const locks = navigator.locks as LockManager | undefined;
  // Without secure-context Web Locks, concurrent HTTP pages can adopt identical queues. Discord nonce deduplication covers only a limited interval.
  if (!locks) return adopt((await idbEntries<OutboxRecord<SavedDraft>[]>(KEY_PREFIX)).filter(([key]) => key !== ownKey));
  await new Promise<void>((held) => void locks.request(LIVE_LOCK_PREFIX + pageId, () => (held(), new Promise<never>(() => {}))));
  await locks.request(CLAIM_LOCK, async () => {
    const live = new Set((await locks.query()).held?.map((l) => l.name));
    const saved = await idbEntries<OutboxRecord<SavedDraft>[]>(KEY_PREFIX);
    await adopt(saved.filter(([key]) => key !== ownKey && !live.has(LIVE_LOCK_PREFIX + key.slice(KEY_PREFIX.length))));
    await whenWritten();
  });
}
// Posting locks suspend sends. First unlock adopts abandoned queues once per page; relocking suspends until another unlock.
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
