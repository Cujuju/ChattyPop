import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { AppEvent, CoreEventMessage, CoreInit, CoreMethod, CoreMethods, CoreRequest, CoreResponse, CoreResult } from '@shared/contract';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Core as main's services reach it: its calls, and the events it pushes. */
export interface MainCore {
  call<M extends CoreMethod>(method: M, ...params: Parameters<CoreMethods[M]>): Promise<CoreResult<M>>;
  on(event: 'event', fn: (e: AppEvent) => void): unknown;
}

/** Owns the core utilityProcess: request/response calls plus the events core pushes. */
export class CoreClient extends EventEmitter<{ event: [AppEvent] }> {
  private readonly proc: UtilityProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(entry: string, init: Omit<CoreInit, 'kind'>) {
    super();
    // Main's environment, INSTALLED_ENV included: core loads the installed plugins main's start accepted.
    this.proc = utilityProcess.fork(entry, [], { serviceName: 'ChattyPop Core', stdio: 'inherit', env: process.env });
    this.proc.on('message', (msg: CoreResponse | CoreEventMessage) => {
      if ('kind' in msg) this.emit('event', msg.event);
      else this.settle(msg);
    });
    this.proc.on('exit', (code) => this.failAll(new Error(`core exited with code ${code}`)));
    this.proc.postMessage({ kind: 'init', ...init } satisfies CoreInit);
  }

  call<M extends CoreMethod>(method: M, ...params: Parameters<CoreMethods[M]>): Promise<CoreResult<M>> {
    const id = this.nextId++;
    const req: CoreRequest<M> = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.postMessage(req);
    });
  }

  dispose(): void {
    this.proc.kill();
  }

  private settle(msg: CoreResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
