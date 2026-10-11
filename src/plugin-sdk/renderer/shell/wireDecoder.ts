import type { WireValue } from '@shared/wire';
import type { DecodeFormat, WireDecodeReply, WireDecodeRequest } from './wireWorkerProtocol';

export interface WireDecoder {
  /** Decodes off the page's UI thread; the worker returns structured-cloned values, including bytes and undefined. */
  decode(text: string, format?: DecodeFormat): Promise<WireValue>;
  /** Rejects outstanding reads and stops the worker. A disposed decoder cannot accept new work. */
  dispose(): void;
}

type Pending = { resolve(value: WireValue): void; reject(error: Error): void };

/** The worker boundary is structural so Node contract tests need no browser DOM library. */
export interface DecoderWorker {
  postMessage(request: WireDecodeRequest): void;
  onmessage: ((event: { data: WireDecodeReply }) => void) | null;
  onerror: ((event: { message?: string; preventDefault(): void }) => void) | null;
  onmessageerror: (() => void) | null;
  terminate(): void;
}

declare const Worker: { new (url: URL, options: { type: 'module' }): DecoderWorker };

/** One lazily started worker per transport. Sequential worker messages preserve event order; ids match concurrent calls. */
export function createWireDecoder(makeWorker: () => DecoderWorker = () => new Worker(new URL('./wire.worker.ts', import.meta.url), { type: 'module' })): WireDecoder {
  const pending = new Map<number, Pending>();
  let worker: DecoderWorker | null = null;
  let nextId = 0;
  let disposed = false;

  function stop(error: Error): void {
    worker?.terminate();
    worker = null;
    for (const read of pending.values()) read.reject(error);
    pending.clear();
  }

  function start(): DecoderWorker {
    if (worker) return worker;
    const started = makeWorker();
    started.onmessage = ({ data }) => {
      if (worker !== started) return;
      const read = pending.get(data.id);
      if (!read) return;
      pending.delete(data.id);
      if (data.ok) read.resolve(data.value);
      else read.reject(new Error(data.error));
    };
    started.onerror = (event) => {
      event.preventDefault();
      if (worker === started) stop(new Error(event.message || 'The response decoder failed.'));
    };
    started.onmessageerror = () => {
      if (worker === started) stop(new Error('The response decoder returned an unreadable message.'));
    };
    worker = started;
    return started;
  }

  return {
    decode(text, format = 'wire') {
      if (disposed) return Promise.reject(new Error('The response decoder was stopped.'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        try {
          const active = start();
          pending.set(id, { resolve, reject });
          active.postMessage({ id, text, format } satisfies WireDecodeRequest);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    dispose() {
      disposed = true;
      stop(new Error('The response decoder was stopped.'));
    },
  };
}
