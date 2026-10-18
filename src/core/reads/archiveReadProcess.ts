// A killable owner for a native SQLite worker; terminating a thread cannot interrupt a native sqlite3_step call.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ReadConnection, ReadQuery, ReadReply } from './protocol';

let worker: Worker | undefined;
let failed = false;
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
      // The worker has stopped, so exit can't hang; exit once the reply is sent.
      failed = true;
      process.send?.({ kind: 'error', message: error.message, fatal: true } satisfies ReadReply, () => process.exit(1));
    });
    worker.on('exit', () => { if (!failed) process.exit(); });
  } else worker!.postMessage(message);
});
// The core owns the IPC pipe. process.exit() waits for a worker blocked in native SQLite, so end through the OS instead.
process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
