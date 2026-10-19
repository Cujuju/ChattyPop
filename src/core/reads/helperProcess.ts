import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { deserialize, serialize } from 'node:v8';

export interface ReadProcess extends EventEmitter {
  stderr: PassThrough;
  send(message: unknown, done: (error: Error | null) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}

/** Windows process creation can exceed a frame even before any archive work starts. */
function forkWorker(): void {
  const { parentPort: port, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
  const { fork } = require('node:child_process') as typeof import('node:child_process');
  const { serialize, deserialize } = require('node:v8') as typeof import('node:v8');
  const child = fork(workerData.entry, [], {
    execPath: workerData.execPath, execArgv: [], serialization: 'advanced',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stderr!.on('data', (data) => port!.postMessage({ kind: 'stderr', data }));
  child.on('message', (message) => port!.postMessage({ kind: 'message', data: serialize(message) }));
  child.on('error', (error) => port!.postMessage({ kind: 'error', message: error.message }));
  child.on('close', (code, signal) => { port!.postMessage({ kind: 'close', code, signal }); port!.close(); });
  port!.on('message', (message: { kind: string; data: Uint8Array; signal: NodeJS.Signals }) => {
    if (message.kind === 'kill') child.kill(message.signal);
    else child.send(deserialize(message.data), (error) => {
      if (error) port!.postMessage({ kind: 'error', message: error.message });
    });
  });
}

/** Fork/IPC proxy. The helper still dies on IPC disconnect, including a supervisor failure. */
export function forkReadHelper(entry: string): ReadProcess {
  const child = new EventEmitter() as ReadProcess;
  child.stderr = new PassThrough();
  const worker = new Worker(`(${forkWorker.toString()})()`, { eval: true, workerData: { entry, execPath: process.execPath } });
  let closed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) return;
    closed = true; child.stderr.end(); child.emit('close', code, signal);
  };
  child.send = (message, done) => {
    if (closed) { done(new Error('Archive read helper exited')); return; }
    try { worker.postMessage({ kind: 'send', data: serialize(message) }); done(null); }
    catch (error) { done(error as Error); }
  };
  child.kill = (signal) => { if (closed) return false; worker.postMessage({ kind: 'kill', signal }); return true; };
  worker.on('message', (message) => {
    if (message.kind === 'message') child.emit('message', deserialize(message.data));
    if (message.kind === 'stderr') child.stderr.write(Buffer.from(message.data));
    if (message.kind === 'error') child.emit('error', new Error(message.message));
    if (message.kind === 'close') close(message.code, message.signal);
  });
  worker.on('error', (error) => child.emit('error', error));
  worker.on('exit', (code) => close(code, null));
  return child;
}
