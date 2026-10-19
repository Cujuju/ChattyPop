import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  AppEvent,
  CoreEventMessage,
  CoreDiagnosticMessage,
  CoreInit,
  CoreInitStep,
  CoreInitStepMessage,
  CoreMethod,
  CoreMethods,
  CoreRequest,
  CoreResponse,
  CoreResult,
} from '@shared/contract';
import { errorMessage } from '@shared/errors';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Core as main's services reach it: its calls, and the events it pushes. */
export interface MainCore {
  call<M extends CoreMethod>(method: M, ...params: Parameters<CoreMethods[M]>): Promise<CoreResult<M>>;
  on(event: 'event', fn: (e: AppEvent) => void): unknown;
}

/** Owns the core utilityProcess: request/response calls plus the events and init milestones core pushes. */
export class CoreClient extends EventEmitter<{ event: [AppEvent]; 'init-step': [CoreInitStep] }> {
  private readonly proc: UtilityProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Why core can no longer answer, once it exited or was stopped; every later call rejects with it. */
  private ended: Error | null = null;

  /** `report`: records a diagnostics event (diagnostics.ts diag). */
  constructor(
    entry: string,
    init: Omit<CoreInit, 'kind'>,
    private readonly report: (event: string, detail: Record<string, unknown>) => void,
  ) {
    super();
    // Main's environment, INSTALLED_ENV included: core loads the installed plugins main's start accepted.
    this.proc = utilityProcess.fork(entry, [], { serviceName: 'ChattyPop Core', stdio: 'inherit', env: process.env });
    this.proc.on('message', (msg: CoreResponse | CoreEventMessage | CoreInitStepMessage | CoreDiagnosticMessage) => {
      if (!('kind' in msg)) this.settle(msg);
      else if (msg.kind === 'diag') this.report(msg.event, msg.detail);
      else if (msg.kind === 'event') this.emit('event', msg.event);
      else this.emit('init-step', msg.step);
    });
    this.proc.on('exit', (code) => {
      // Stopped: dispose ended it first.
      this.report('core-exited', { code, stopped: this.ended !== null });
      this.end(new Error(`core exited with code ${code}`));
    });
    this.proc.postMessage({ kind: 'init', ...init } satisfies CoreInit);
  }

  call<M extends CoreMethod>(method: M, ...params: Parameters<CoreMethods[M]>): Promise<CoreResult<M>> {
    // A dead utilityProcess drops posted messages silently, so the call would never settle.
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    const req: CoreRequest<M> = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.proc.postMessage(req);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Calls `method` without waiting for it: main's one path for that. A failure is recorded, never left unhandled; once core
   * has ended, its exit is the one record.
   */
  tell<M extends CoreMethod>(method: M, ...params: Parameters<CoreMethods[M]>): void {
    this.call(method, ...params).catch((err: unknown) => {
      if (err !== this.ended) this.report('core-call-failed', { method, message: errorMessage(err) });
    });
  }

  dispose(): void {
    this.end(new Error('core was stopped'));
    this.proc.kill();
  }

  private settle(msg: CoreResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  /** Records the first reason core ended and rejects every call still waiting on it. */
  private end(err: Error): void {
    this.ended ??= err;
    for (const p of this.pending.values()) p.reject(this.ended);
    this.pending.clear();
  }
}
