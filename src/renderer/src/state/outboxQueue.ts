// Messages on their way to Discord: taken out of the composer on Send, then sent one at a time per channel, in order.
// Each goes in three phases: its videos shrunk, its files uploaded in pieces, then the post. Files stay by reference.
// Saved on every change and loaded after a reload. A send that couldn't reach the desktop retries by itself while
// Discord still dedupes its nonce. DOM-free (the app is injected), so it is tested directly; state/outbox.ts wires it.
import { batch, createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { OwnerMessage, PostedOwnerMessage } from '@shared/compose';
import { MS_PER_MIN, MS_PER_S } from '@shared/units';

export type OutgoingStatus = 'queued' | 'sending' | 'failed';
/** What a sending message is doing: shrinking its videos, uploading its files, or posting. */
export type OutgoingPhase = 'preparing' | 'uploading' | 'posting';

export interface Outgoing {
  id: number;
  nonce: string;
  /** What it's called where it can't show whole: its text, or what it carries. */
  label: string;
  /** Its text as the log shows it pending. */
  text: string;
  /** Names for the text's `<@id>` mentions, by id, as picked. */
  mentions: Record<string, string>;
  /** What it carries, as picked. */
  files: File[];
  status: OutgoingStatus;
  error: string | null;
  /** Edit can put it back in the composer (a GIF or sticker isn't part of a draft). */
  editable: boolean;
  /** Retry can send it: false once its files are lost (it would go without them). */
  retryable: boolean;
  phase: OutgoingPhase | null;
  /** Fraction done of the phase; null when it can't tell. */
  progress: number | null;
}

/** What a composer hands over to send. `D` is the composer's saved form of the draft, for Edit. */
export interface OutboxJob<D> {
  channelId: string;
  label: string;
  /** The message without its files; built once, so every attempt sends the same nonce. */
  message: OwnerMessage;
  files: File[];
  /** Names for its `<@id>` mentions, by id, as picked: the pending row shows them before the archive knows them. */
  mentions: Record<string, string>;
  /** What Edit puts back in the composer; null when it can't go back (a GIF, a sticker). Structured-cloneable. */
  draft: D | null;
}

/** A queued message as saved: plain data and Files, so it survives a reload. */
export interface OutboxRecord<D> {
  channelId: string;
  label: string;
  message: OwnerMessage;
  files: File[];
  /** Absent in records saved before mention names. */
  mentions?: Record<string, string>;
  draft: D | null;
  status: OutgoingStatus;
  error: string | null;
  /** When its post first went: a retry by itself is safe only while Discord still dedupes its nonce. */
  firstSentAt: number | null;
  /** Its last failure may not have reached Discord (no desktop, no answer): it may retry by itself. */
  unreachable: boolean;
  /** Its finished uploads, while the desktop holds them; null until uploaded. */
  uploads: string[] | null;
  /** How many files it carries; more than `files` holds when their save failed. Absent in records saved with their files. */
  fileCount?: number;
}

export interface OutboxDeps<D> {
  send(m: OwnerMessage): Promise<PostedOwnerMessage>;
  /** Publishes the accepted row in the same batch that removes its pending row. */
  accept?(result: PostedOwnerMessage): void;
  /** Timing-only observer; paint observers are wired by the window. */
  mark?(phase: 'enqueue' | 'rpc-start' | 'rpc-end' | 'accepted', nonce: string, id: number, messageId?: string): void;
  /** The files as they'll be uploaded (videos shrunk to this device's quality); reports progress. */
  prepare(channelId: string, files: File[], progress: (fraction: number) => void): Promise<File[]>;
  /** Uploads the files in pieces, reporting progress; resolves the tokens the message names. */
  upload(channelId: string, files: File[], progress: (fraction: number) => void): Promise<string[]>;
  /** The desktop no longer holds the message's uploads (UPLOAD_GONE): they go again. */
  uploadGone(err: unknown): boolean;
  /** The desktop refused to post past the message's postWithinMs (POST_WINDOW_PASSED). */
  windowPassed(err: unknown): boolean;
  errorText(err: unknown): string;
  /** The desktop couldn't be reached: the message may not have been posted, and may go again with its nonce. */
  unreachable(err: unknown): boolean;
  /** Puts a draft back in the channel's composer; false when the composer has something new in it. */
  restore(channelId: string, draft: D): boolean;
  /** Keeps the queue: called after every change of state (not of progress). */
  save(records: OutboxRecord<D>[]): void;
  now(): number;
  /** Posting is unlocked (state/posting.ts): while it isn't, nothing is sent and messages wait, queued. */
  unlocked(): boolean;
  /** The send was refused unsent because posting is locked (isPostingLocked). */
  locked(err: unknown): boolean;
}

/** A post answers within seconds; with nothing back by now, the desktop or Discord has stalled. */
export const SEND_BASE_TIMEOUT_MS = 30 * MS_PER_S;
/** Discord dedupes a nonce for "a few minutes" (undocumented); retries by themselves stay well inside that. */
export const NONCE_DEDUPE_MS = 2 * MS_PER_MIN;
/** How often an unreachable send tries again while its nonce holds, besides on reconnect. */
export const AUTO_RETRY_MS = 15 * MS_PER_S;
const TIMED_OUT = 'Sending is taking too long. It may still arrive; retrying within a few minutes won’t post it twice.';
const INTERRUPTED = 'The app closed while this was sending.';
const UNREACHABLE = 'Can’t reach the desktop. Retrying when it’s back.';
const CHECK_FIRST = 'Couldn’t confirm it was sent. Check the channel first: Retry now could post it twice.';
const FILES_LOST = 'Its files couldn’t be kept when the app closed. Edit to attach them again, or Discard.';
/** A post not confirmed by the owner stopped: past the nonce window, only the owner's Retry may send it. */
class CheckFirst extends Error {}

interface Entry<D> {
  job: OutboxJob<D>;
  firstSentAt: number | null;
  unreachable: boolean;
  uploads: string[] | null;
  /** The files as prepared for upload; kept across retries while the page lives. */
  prepared: File[] | null;
  /**
   * The owner's Retry asked for it: it posts without a deadline. Otherwise (a first send, a retry by itself, one loaded
   * after a reload) it posts only while Discord still dedupes its nonce. Lasts until a post attempt fails.
   */
  confirmed: boolean;
  /** Files it carries, saved or not: more than job.files when their save failed. */
  fileCount: number;
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
        if (!e) continue;
        const { channelId, label, message, files, mentions, draft } = e.job;
        records.push({ channelId, label, message, files, mentions, draft, status, error, firstSentAt: e.firstSentAt, unreachable: e.unreachable, uploads: e.uploads, fileCount: e.fileCount });
      }
    }
    deps.save(records);
  }

  /** In place, so a reader of other fields (the log's rows read ids) isn't woken by progress. */
  const update = (channelId: string, id: number, change: Partial<Outgoing>): void => void setOutbox(channelId, (o) => o.id === id, change);

  function patch(channelId: string, id: number, change: Partial<Outgoing>): void {
    update(channelId, id, change);
    save();
  }

  /** Idempotent: a timed-out send that lands later and a retry that succeeds may both finish it. */
  function finish(channelId: string, id: number): void {
    if (!entries.delete(id)) return;
    setOutbox(channelId, (list) => list.filter((o) => o.id !== id));
    save();
  }

  function add(job: OutboxJob<D>, state: Pick<Outgoing, 'status' | 'error'>, saved?: OutboxRecord<D>): number {
    const id = nextId++;
    const fileCount = saved?.fileCount ?? job.files.length;
    entries.set(id, { job, firstSentAt: saved?.firstSentAt ?? null, unreachable: saved?.unreachable ?? false, uploads: saved?.uploads ?? null, prepared: null, confirmed: false, fileCount });
    const retryable = job.files.length >= fileCount;
    const row: Outgoing = { id, nonce: job.message.nonce, label: job.label, text: job.message.text, mentions: job.mentions, files: job.files, ...state, editable: job.draft !== null, retryable, phase: null, progress: null };
    setOutbox(produce((all) => void (all[job.channelId] ??= []).push(row)));
    undismiss(job.channelId);
    return id;
  }

  function enqueue(job: OutboxJob<D>): void {
    const id = add(job, { status: 'queued', error: null });
    deps.mark?.('enqueue', job.message.nonce, id);
    save();
    void pump(job.channelId);
  }

  /**
   * Takes saved messages into the queue (after a reload). One cut off while posting may have posted: failed, and retried
   * only while its nonce holds. One whose files weren't kept fails for good: sent, it would go without them.
   */
  function load(records: OutboxRecord<D>[]): void {
    for (const r of records) {
      const files = r.files ?? [];
      const lost = files.length < (r.fileCount ?? files.length);
      const interrupted = r.status === 'sending';
      const job: OutboxJob<D> = { channelId: r.channelId, label: r.label, message: r.message, files, mentions: r.mentions ?? {}, draft: r.draft };
      const state = lost ? { status: 'failed' as const, error: FILES_LOST } : interrupted ? { status: 'failed' as const, error: INTERRUPTED } : { status: r.status, error: r.error };
      add(job, state, { ...r, unreachable: !lost && (interrupted || r.unreachable) });
    }
    save();
    for (const channelId of new Set(records.map((r) => r.channelId))) void pump(channelId);
    retryUnreachable();
  }

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

  /** Uploads the message's files once (prepared first); a later attempt reuses them while the desktop holds them. */
  async function uploadFiles(channelId: string, id: number, e: Entry<D>): Promise<void> {
    if (!e.job.files.length || e.uploads) return;
    update(channelId, id, { phase: 'preparing', progress: 0 });
    const prepared = e.prepared ?? (await deps.prepare(channelId, e.job.files, (p) => update(channelId, id, { progress: p })));
    e.prepared = prepared;
    update(channelId, id, { phase: 'uploading', progress: 0 });
    e.uploads = await deps.upload(channelId, prepared, (p) => update(channelId, id, { progress: p }));
    save();
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
        /** Uploads from an earlier attempt: if the desktop let them go, this attempt uploads again. */
        const reused = e.uploads !== null;
        patch(channelId, id, { status: 'sending', error: null });
        let failure: string | null = null;
        try {
          await uploadFiles(channelId, id, e);
          // Saved before the post goes: after a reload, firstSentAt says it may have posted.
          e.firstSentAt ??= deps.now();
          // Unconfirmed, it posts only inside the nonce window (main enforces it after any queue wait): else it could post twice.
          const postWithinMs = e.confirmed ? undefined : e.firstSentAt + NONCE_DEDUPE_MS - deps.now();
          if (postWithinMs !== undefined && postWithinMs <= 0) throw new CheckFirst();
          patch(channelId, id, { phase: 'posting', progress: null });
          deps.mark?.('rpc-start', e.job.message.nonce, id);
          const sent = deps.send({ ...e.job.message, uploads: e.uploads ?? [], ...(postWithinMs === undefined ? {} : { postWithinMs }) }).then((posted) => {
            batch(() => {
              deps.accept?.(posted);
              finish(channelId, id);
            });
            deps.mark?.('accepted', e.job.message.nonce, id, posted.message.id);
          }).finally(() => deps.mark?.('rpc-end', e.job.message.nonce, id));
          if ((await within(sent, SEND_BASE_TIMEOUT_MS)) === 'timeout') {
            failure = TIMED_OUT;
            e.unreachable = true;
            // Landing later means it went: the send's own handler drops it; send the rest.
            sent.then(
              () => {
                void pump(channelId);
              },
              () => undefined,
            );
          }
        } catch (err) {
          if (deps.locked(err)) {
            // Refused unsent (locked meanwhile): it waits, queued, for resume.
            e.firstSentAt = firstSentBefore;
            patch(channelId, id, { status: 'queued', error: null, phase: null, progress: null });
            return;
          }
          if (deps.uploadGone(err) && reused) {
            // The desktop let its uploads go (restarted, or held them too long): upload again; the post never went.
            e.uploads = null;
            e.firstSentAt = firstSentBefore;
            patch(channelId, id, { status: 'queued', phase: null, progress: null });
            continue;
          }
          // Never put back in the composer on its own: a lost answer can hide a post that went through, and only a resend reuses its nonce.
          if (err instanceof CheckFirst || deps.windowPassed(err)) {
            e.unreachable = false;
            failure = CHECK_FIRST;
          } else {
            e.unreachable = deps.unreachable(err);
            failure = e.unreachable ? UNREACHABLE : deps.errorText(err);
          }
        }
        if (failure === null) finish(channelId, id);
        else {
          e.confirmed = false;
          patch(channelId, id, { status: 'failed', error: failure, phase: null, progress: null });
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
   * reconnect, and every AUTO_RETRY_MS while one waits); one whose post never went retries any time. Past that, only
   * the owner's Retry sends it, after a warning.
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
        resend(channelId, head.id, false);
      } else {
        e.unreachable = false;
        patch(channelId, head.id, { error: CHECK_FIRST });
      }
    }
    if (waiting) scheduleRetry();
  }

  /** Sends the channel's failed head again, then the rest behind it; `confirmed`: the owner asked (no nonce deadline). */
  function resend(channelId: string, id: number, confirmed: boolean): void {
    const e = entries.get(id);
    if (!e || e.job.files.length < e.fileCount) return;
    e.confirmed = confirmed;
    patch(channelId, id, { status: 'queued', error: null });
    void pump(channelId);
  }

  /** The owner's Retry: sends the failed head again even past the nonce window (after CHECK_FIRST warned them). */
  const retrySend = (channelId: string, id: number): void => resend(channelId, id, true);

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
