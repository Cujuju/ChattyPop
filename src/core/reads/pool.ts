import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ReadConnection, ReadQuery, ReadReply } from './protocol';

/** Two concurrent readers allow unrelated lookups without multiplying archive scans across every plugin. */
export const ARCHIVE_READ_POOL_SIZE = 2;
/** Bound retained SQL/parameters; callers retry after existing work settles. */
export const ARCHIVE_READ_QUEUE_MAX = 32;
/** Limit repeated abort/crash process churn; replacements are demand-driven after exit, and failed jobs are never retried. */
export const ARCHIVE_READ_RESPAWN_DELAY_MS = 50;

interface Job extends ReadQuery {
  resolve(rows: unknown[]): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface Slot { process: ChildProcess; job?: Job; stopping: boolean; exited: Promise<void> }

export class ArchiveReadPool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private closed = false;
  private respawnAt = 0;
  private respawnTimer?: NodeJS.Timeout;

  constructor(private readonly connection: ReadConnection, private readonly entry = join(import.meta.dirname, 'archiveReadProcess.js')) {}

  read<R>(sql: string, params: ReadQuery['params'], signal?: AbortSignal): Promise<R[]> {
    return new Promise<unknown[]>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (this.closed) return reject(new Error('Archive reader is closed'));
      if (this.queue.length >= ARCHIVE_READ_QUEUE_MAX) return reject(new Error('Archive read queue is full'));
      const job: Job = { sql, params, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = (): void => {
        const queued = this.queue.indexOf(job);
        if (queued !== -1) this.queue.splice(queued, 1);
        const slot = [...this.slots].find((s) => s.job === job);
        if (slot) { slot.job = undefined; this.stop(slot); }
        job.cleanup();
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.drain();
    }) as Promise<R[]>;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = undefined;
    this.cancel(new Error('Archive reader is closed'));
    await Promise.all([...this.slots].map((s) => s.exited));
  }

  cancel(error: Error): void {
    for (const job of this.queue.splice(0)) this.fail(job, error);
    for (const slot of this.slots) {
      if (slot.job) this.fail(slot.job, error);
      slot.job = undefined;
      this.stop(slot);
    }
  }

  private fail(job: Job, error: unknown): void { job.cleanup(); job.reject(error); }

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
      job.cleanup();
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
    while (this.queue.length) {
      let slot = [...this.slots].find((s) => !s.stopping && !s.job);
      if (!slot && this.slots.size < ARCHIVE_READ_POOL_SIZE) {
        const wait = this.respawnAt - performance.now();
        if (wait > 0) {
          this.respawnTimer ??= setTimeout(() => { this.respawnTimer = undefined; this.drain(); }, wait);
          return;
        }
        try { slot = this.spawn(); }
        catch (error) { this.fail(this.queue.shift()!, error); continue; }
      }
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      const failed = (error: Error | null): void => {
        if (error && slot!.job === job) { this.fail(job, error); slot!.job = undefined; this.stop(slot!); }
      };
      try { slot.process.send({ sql: job.sql, params: job.params }, failed); }
      catch (error) { failed(error as Error); }
    }
  }
}
