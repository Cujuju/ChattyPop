// Messages on their way to Discord: taken out of the composer on Send, then sent one at a time per channel, in order.
// Saved on every change and loaded after a reload. A send that couldn't reach the desktop retries by itself while
// Discord still dedupes its nonce. DOM-free (the app is injected), so it is tested directly; state/outbox.ts wires it.
import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { OwnerMessage } from '@shared/compose';
import { MS_PER_MIN, MS_PER_S } from '@shared/units';

export type OutgoingStatus = 'queued' | 'sending' | 'failed';

export interface Outgoing {
  id: number;
  /** What the Sending panel calls it: its text, or what it carries. */
  label: string;
  status: OutgoingStatus;
  error: string | null;
  /** Edit can put it back in the composer (a GIF or sticker isn't part of a draft). */
  editable: boolean;
}

/** What a composer hands over to send. `D` is the composer's saved form of the draft, for Edit. */
export interface OutboxJob<D> {
  channelId: string;
  label: string;
  /** Built once (file bytes read), so every attempt sends the same nonce. */
  message: Promise<OwnerMessage>;
  /** Upload size, which stretches the time a send may take. */
  bytes: number;
  /** What Edit puts back in the composer; null when it can't go back (a GIF, a sticker). Structured-cloneable. */
  draft: D | null;
}

/** A queued message as saved: plain data, so it survives a reload. */
export interface OutboxRecord<D> {
  channelId: string;
  label: string;
  message: OwnerMessage;
  bytes: number;
  draft: D | null;
  status: OutgoingStatus;
  error: string | null;
  /** When it was first sent: a retry by itself is safe only while Discord still dedupes its nonce. */
  firstSentAt: number | null;
  /** Its last failure may not have reached Discord (no desktop, no answer): it may retry by itself. */
  unreachable: boolean;
}

export interface OutboxDeps<D> {
  send(m: OwnerMessage): Promise<void>;
  errorText(err: unknown): string;
  /** The desktop couldn't be reached: the message may not have been posted, and may go again with its nonce. */
  unreachable(err: unknown): boolean;
  /** Puts a draft back in the channel's composer; false when the composer has something new in it. */
  restore(channelId: string, draft: D): boolean;
  /** Keeps the queue: called after every change with every message whose bytes are read. */
  save(records: OutboxRecord<D>[]): void;
  now(): number;
  /** Posting is unlocked (state/posting.ts): while it isn't, nothing is sent and messages wait, queued. */
  unlocked(): boolean;
  /** The send was refused unsent because posting is locked (isPostingLocked). */
  locked(err: unknown): boolean;
}

/** A text post answers within seconds; with nothing back by now, the desktop or Discord has stalled. */
export const SEND_BASE_TIMEOUT_MS = 30 * MS_PER_S;
/** A slow phone uplink (~2 Mbit/s); uploads slower than this count as stalled. */
const MIN_UPLOAD_BYTES_PER_S = 256 * 1024;
/** Discord dedupes a nonce for "a few minutes" (undocumented); retries by themselves stay well inside that. */
export const NONCE_DEDUPE_MS = 2 * MS_PER_MIN;
/** How often an unreachable send tries again while its nonce holds, besides on reconnect. */
export const AUTO_RETRY_MS = 15 * MS_PER_S;
const TIMED_OUT = 'Sending is taking too long. It may still arrive; retrying within a few minutes won’t post it twice.';
const INTERRUPTED = 'The app closed while this was sending.';
const UNREACHABLE = 'Can’t reach the desktop. Retrying when it’s back.';
const CHECK_FIRST = 'Couldn’t confirm it was sent. Check the channel first: Retry now could post it twice.';

interface Entry<D> {
  job: OutboxJob<D>;
  /** The built message, once its bytes are read; saved only then. */
  message: OwnerMessage | null;
  firstSentAt: number | null;
  unreachable: boolean;
}

export function createOutbox<D>(deps: OutboxDeps<D>) {
  const [outbox, setOutbox] = createStore<Record<string, Outgoing[]>>({});
  const entries = new Map<number, Entry<D>>();
  const pumping = new Set<string>();
  let nextId = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());

  /** The channel's messages not yet sent, oldest first; a failed one holds those behind it. */
  const outgoing = (channelId: string): Outgoing[] => outbox[channelId] ?? [];
  /** The Sending panel was tapped away; a new message or a failure shows it again. */
  const sendingDismissed = (channelId: string): boolean => dismissed().has(channelId);
  const dismissSending = (channelId: string): void => void setDismissed((s) => new Set(s).add(channelId));
  const undismiss = (channelId: string): void =>
    void setDismissed((s) => {
      const next = new Set(s);
      next.delete(channelId);
      return next;
    });

  function save(): void {
    const records: OutboxRecord<D>[] = [];
    for (const list of Object.values(outbox)) {
      for (const { id, status, error } of list) {
        const e = entries.get(id);
        if (!e?.message) continue;
        const { channelId, label, bytes, draft } = e.job;
        records.push({ channelId, label, bytes, draft, message: e.message, status, error, firstSentAt: e.firstSentAt, unreachable: e.unreachable });
      }
    }
    deps.save(records);
  }

  function patch(channelId: string, id: number, change: Partial<Outgoing>): void {
    setOutbox(channelId, (list) => list.map((o) => (o.id === id ? { ...o, ...change } : o)));
    save();
  }

  /** Idempotent: a timed-out send that lands later and a retry that succeeds may both finish it. */
  function finish(channelId: string, id: number): void {
    if (!entries.delete(id)) return;
    setOutbox(channelId, (list) => list.filter((o) => o.id !== id));
    save();
  }

  function add(job: OutboxJob<D>, state: Pick<Outgoing, 'status' | 'error'>, saved?: OutboxRecord<D>): void {
    const id = nextId++;
    const entry: Entry<D> = { job, message: saved?.message ?? null, firstSentAt: saved?.firstSentAt ?? null, unreachable: saved?.unreachable ?? false };
    entries.set(id, entry);
    setOutbox(produce((all) => void (all[job.channelId] ??= []).push({ id, label: job.label, ...state, editable: job.draft !== null })));
    undismiss(job.channelId);
    if (!saved)
      job.message.then(
        (m) => {
          entry.message = m;
          if (entries.has(id)) save();
        },
        () => undefined,
      );
  }

  function enqueue(job: OutboxJob<D>): void {
    add(job, { status: 'queued', error: null });
    void pump(job.channelId);
  }

  /** Takes saved messages into the queue (after a reload). One cut off while sending may have posted: failed, and retried only while its nonce holds. */
  function load(records: OutboxRecord<D>[]): void {
    for (const r of records) {
      const interrupted = r.status === 'sending';
      const job: OutboxJob<D> = { channelId: r.channelId, label: r.label, message: Promise.resolve(r.message), bytes: r.bytes, draft: r.draft };
      add(job, interrupted ? { status: 'failed', error: INTERRUPTED } : { status: r.status, error: r.error }, { ...r, unreachable: interrupted || r.unreachable });
    }
    save();
    for (const channelId of new Set(records.map((r) => r.channelId))) void pump(channelId);
    retryUnreachable();
  }

  const timeoutMs = (job: OutboxJob<D>): number => SEND_BASE_TIMEOUT_MS + (job.bytes / MIN_UPLOAD_BYTES_PER_S) * MS_PER_S;

  /** `sent`, or 'timeout' once `ms` passes first; `sent` keeps running. */
  async function within(sent: Promise<void>, ms: number): Promise<'sent' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
    try {
      return await Promise.race([sent.then(() => 'sent' as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends the channel's queue head first; stops at a failure so nothing overtakes it. */
  async function pump(channelId: string): Promise<void> {
    if (pumping.has(channelId)) return;
    pumping.add(channelId);
    try {
      for (let head = outgoing(channelId)[0]; head && head.status !== 'failed' && deps.unlocked(); head = outgoing(channelId)[0]) {
        const { id } = head;
        const e = entries.get(id)!;
        const firstSentBefore = e.firstSentAt;
        e.firstSentAt ??= deps.now();
        patch(channelId, id, { status: 'sending', error: null });
        let failure: string | null = null;
        const sent = e.job.message.then((m) => deps.send(m));
        try {
          if ((await within(sent, timeoutMs(e.job))) === 'timeout') {
            failure = TIMED_OUT;
            e.unreachable = true;
            // Landing later means it went: drop it (unless a retry is already on it) and send the rest.
            sent.then(
              () => {
                if (outgoing(channelId).find((o) => o.id === id)?.status !== 'failed') return;
                finish(channelId, id);
                void pump(channelId);
              },
              () => undefined,
            );
          }
        } catch (err) {
          if (deps.locked(err)) {
            // Refused unsent (locked meanwhile): it waits, queued, for resume.
            e.firstSentAt = firstSentBefore;
            patch(channelId, id, { status: 'queued', error: null });
            return;
          }
          // Never put back in the composer on its own: a lost answer can hide a post that went through, and only a resend reuses its nonce.
          e.unreachable = deps.unreachable(err);
          failure = e.unreachable ? UNREACHABLE : deps.errorText(err);
        }
        if (failure === null) finish(channelId, id);
        else {
          patch(channelId, id, { status: 'failed', error: failure });
          undismiss(channelId);
          if (e.unreachable) scheduleRetry();
        }
      }
    } finally {
      pumping.delete(channelId);
    }
  }

  function scheduleRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(retryUnreachable, AUTO_RETRY_MS);
  }

  /**
   * Resends each channel's failed head that may not have reached Discord, while Discord still dedupes its nonce (on
   * reconnect, and every AUTO_RETRY_MS while one waits). Past that, only the owner's Retry sends it, after a warning.
   */
  function retryUnreachable(): void {
    if (!deps.unlocked()) return;
    let waiting = false;
    for (const [channelId, list] of Object.entries(outbox)) {
      const head = list[0];
      const e = head?.status === 'failed' ? entries.get(head.id) : undefined;
      if (!head || !e?.unreachable) continue;
      if (e.firstSentAt === null || deps.now() - e.firstSentAt < NONCE_DEDUPE_MS) {
        waiting = true;
        retrySend(channelId, head.id);
      } else {
        e.unreachable = false;
        patch(channelId, head.id, { error: CHECK_FIRST });
      }
    }
    if (waiting) scheduleRetry();
  }

  /** Sends the channel's failed head again, then the rest behind it. */
  function retrySend(channelId: string, id: number): void {
    patch(channelId, id, { status: 'queued', error: null });
    void pump(channelId);
  }

  /** Puts a failed message back in the empty composer to change it; the ones behind it go on. False when the draft isn't empty. */
  function editSend(channelId: string, id: number): boolean {
    const draft = entries.get(id)?.job.draft;
    if (!draft || !deps.restore(channelId, draft)) return false;
    finish(channelId, id);
    void pump(channelId);
    return true;
  }

  /** Drops a failed message; the ones behind it go on. */
  function discardSend(channelId: string, id: number): void {
    finish(channelId, id);
    void pump(channelId);
  }

  /** Posting locked: the automatic retry stops; pumps stop before their next send. */
  function suspend(): void {
    clearTimeout(retryTimer);
  }

  /** Posting unlocked: each channel's waiting head goes, and what couldn't reach the desktop retries. */
  function resume(): void {
    for (const [channelId, list] of Object.entries(outbox)) if (list[0]?.status === 'queued') void pump(channelId);
    retryUnreachable();
  }

  return { outgoing, sendingDismissed, dismissSending, enqueue, load, retryUnreachable, retrySend, editSend, discardSend, suspend, resume };
}
