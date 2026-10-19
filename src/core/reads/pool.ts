import { fork, type ChildProcess } from 'node:child_process';
import { serialize } from 'node:v8';
import type { ReadPriority } from '@shared/readPriority';
import { join } from 'node:path';
import type { ReadConnection, ReadQuery, ReadReply } from './protocol';

/** Two concurrent readers allow unrelated lookups without multiplying archive scans across every plugin. */
export const ARCHIVE_READ_POOL_SIZE = 2;
/** Visible resources may burst together; retain at most 32 distinct waiting interactive queries. */
export const ARCHIVE_READ_INTERACTIVE_QUEUE_MAX = 32;
/** Background scans retain fewer queries so hidden work cannot exhaust interactive admission. */
export const ARCHIVE_READ_BACKGROUND_QUEUE_MAX = 16;
/** Admit one waiting background query after eight interactive dispatches, bounding starvation without preempting native reads. */
export const ARCHIVE_READ_INTERACTIVE_BURST = 8;
/** Limit repeated abort/crash process churn; replacements are demand-driven after exit, and failed jobs are never retried. */
export const ARCHIVE_READ_RESPAWN_DELAY_MS = 50;

interface Job extends ReadQuery {
  key: string;
  lane: ReadPriority;
  promise: Promise<unknown[]>;
  consumers: number;
  resolve(rows: unknown[]): void;
  reject(error: unknown): void;
  cleanups: Set<() => void>;
}
interface Slot { process: ChildProcess; job?: Job; stopping: boolean; exited: Promise<void> }

export class ArchiveReadPool {
  private readonly slots = new Set<Slot>();
  private readonly queues: Record<ReadPriority, Job[]> = { interactive: [], background: [] };
  private readonly queued = new Map<string, Job>();
  private interactiveBurst = 0;
  private closed = false;
  private respawnAt = 0;
  private respawnTimer?: NodeJS.Timeout;

  constructor(private readonly connection: ReadConnection, private readonly entry = join(import.meta.dirname, 'archiveReadProcess.js')) {}

  read<R>(sql: string, params: ReadQuery['params'], signal?: AbortSignal, lane: ReadPriority = 'background'): Promise<R[]> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error('Archive reader is closed'));
    const normalized = Array.isArray(params) ? params : Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const key = serialize([sql, normalized, lane]).toString('base64');
    let job = this.queued.get(key);
    if (!job) {
      const cap = lane === 'interactive' ? ARCHIVE_READ_INTERACTIVE_QUEUE_MAX : ARCHIVE_READ_BACKGROUND_QUEUE_MAX;
      if (this.queues[lane].length >= cap) return Promise.reject(new Error(`Archive ${lane} read queue is full`));
      let resolve!: Job['resolve'];
      let reject!: Job['reject'];
      const promise = new Promise<unknown[]>((yes, no) => { resolve = yes; reject = no; });
      job = { sql, params: structuredClone(params), key, lane, promise, resolve, reject, consumers: 0, cleanups: new Set() };
      this.queued.set(key, job);
      this.queues[lane].push(job);
    }
    const result = this.subscribe(job, signal);
    this.drain();
    return result as Promise<R[]>;
  }

  private subscribe(job: Job, signal?: AbortSignal): Promise<unknown[]> {
    job.consumers++;
    if (!signal) return job.promise;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', abort); job.cleanups.delete(cleanup); };
      const abort = (): void => {
        cleanup();
        reject(signal.reason);
        if (--job.consumers) return;
        const queue = this.queues[job.lane];
        const index = queue.indexOf(job);
        if (index !== -1) { queue.splice(index, 1); this.queued.delete(job.key); }
        const slot = [...this.slots].find((s) => s.job === job);
        if (slot) { slot.job = undefined; this.stop(slot); }
        this.fail(job, signal.reason);
      };
      job.cleanups.add(cleanup);
      signal.addEventListener('abort', abort, { once: true });
      job.promise.then((rows) => { cleanup(); if (!signal.aborted) resolve(rows); }, (error) => { cleanup(); reject(error); });
    });
  }

  private dequeue(): Job | undefined {
    const { interactive, background } = this.queues;
    const lane = background.length && (!interactive.length || this.interactiveBurst >= ARCHIVE_READ_INTERACTIVE_BURST) ? 'background' : 'interactive';
    const job = this.queues[lane].shift();
    if (!job) return;
    this.queued.delete(job.key);
    this.interactiveBurst = lane === 'background' ? 0 : Math.min(this.interactiveBurst + 1, ARCHIVE_READ_INTERACTIVE_BURST);
    return job;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = undefined;
    this.cancel(new Error('Archive reader is closed'));
    await Promise.all([...this.slots].map((s) => s.exited));
  }

  cancel(error: Error): void {
    for (const queue of Object.values(this.queues)) for (const job of queue.splice(0)) this.fail(job, error);
    this.queued.clear();
    for (const slot of this.slots) {
      if (slot.job) this.fail(slot.job, error);
      slot.job = undefined;
      this.stop(slot);
    }
  }

  private cleanup(job: Job): void { for (const cleanup of job.cleanups) cleanup(); }
  private fail(job: Job, error: unknown): void { this.cleanup(job); job.reject(error); }

  private stop(slot: Slot): void {
    if (slot.stopping) return;
    slot.stopping = true;
    // SIGKILL targets only this owned read-only helper, never the app or its core process.
    slot.process.kill('SIGKILL');
  }

  private spawn(): Slot {
    const child = fork(this.entry, [], {
      execPath: process.execPath, execArgv: [], serialization: 'advanced',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    const slot: Slot = { process: child, stopping: false, exited: new Promise((resolve) => child.once('close', () => resolve())) };
    this.slots.add(slot);
    child.on('message', (reply: ReadReply) => {
      if (reply.kind === 'started' || slot.stopping || !slot.job) return;
      const job = slot.job;
      slot.job = undefined;
      this.cleanup(job);
      if (reply.kind === 'rows') job.resolve(reply.rows);
      else {
        if (reply.fatal) this.stop(slot);
        job.reject(Object.assign(new Error(reply.message), { code: reply.code }));
      }
      this.drain();
    });
    child.on('error', (error) => {
      if (slot.job) this.fail(slot.job, error);
      slot.job = undefined;
      this.stop(slot);
    });
    child.on('close', () => {
      if (slot.job) this.fail(slot.job, new Error('Archive read helper exited'));
      this.slots.delete(slot);
      if (!this.closed) { this.respawnAt = performance.now() + ARCHIVE_READ_RESPAWN_DELAY_MS; this.drain(); }
    });
    child.send(this.connection, (error) => { if (error) this.stop(slot); });
    return slot;
  }

  private drain(): void {
    if (this.closed) return;
    while (this.queued.size) {
      let slot = [...this.slots].find((s) => !s.stopping && !s.job);
      if (!slot && this.slots.size < ARCHIVE_READ_POOL_SIZE) {
        const wait = this.respawnAt - performance.now();
        if (wait > 0) {
          this.respawnTimer ??= setTimeout(() => { this.respawnTimer = undefined; this.drain(); }, wait);
          return;
        }
        try { slot = this.spawn(); }
        catch (error) { this.fail(this.dequeue()!, error); continue; }
      }
      if (!slot) return;
      const job = this.dequeue()!;
      slot.job = job;
      const failed = (error: Error | null): void => {
        if (error && slot!.job === job) { this.fail(job, error); slot!.job = undefined; this.stop(slot!); }
      };
      try { slot.process.send({ sql: job.sql, params: job.params }, failed); }
      catch (error) { failed(error as Error); }
    }
  }
}
