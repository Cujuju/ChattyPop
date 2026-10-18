// A killable owner for a native SQLite worker; terminating a thread cannot interrupt a native sqlite3_step call.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ReadConnection, ReadQuery, ReadReply } from './protocol';

let worker: Worker | undefined;
process.on('message', (message: ReadConnection | ReadQuery) => {
  if ('path' in message) {
    worker = new Worker(join(import.meta.dirname, 'archiveReadWorker.js'), { workerData: message });
    worker.on('message', (reply: ReadReply) => {
      if (reply.kind === 'rows') {
        // Worker structured clone turns SQLite blobs into Uint8Arrays; preserve the synchronous API's Buffer results.
        for (const row of reply.rows as Record<string, unknown>[]) {
          for (const [key, value] of Object.entries(row)) if (value instanceof Uint8Array) row[key] = Buffer.from(value);
        }
      }
      process.send?.(reply);
    });
    worker.on('error', (error) => {
      process.send?.({ kind: 'error', message: error.message, fatal: true } satisfies ReadReply);
      process.exitCode = 1;
      process.disconnect();
    });
    worker.on('exit', () => process.exit());
  } else worker!.postMessage(message);
});
// The core owns the IPC pipe. Its death must also end readers, including a worker blocked in native code.
process.on('disconnect', () => process.exit());
