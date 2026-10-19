import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';

export interface CliSpawnOptions { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
/** The stdio/lifecycle surface used by SDK and JSON-RPC CLI transports. */
export interface CliProcess extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Closure-free worker: even Windows CreateProcess and SDK executable probes stay off Core. */
function processWorker(): void {
  const { parentPort: port, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const child = spawn(workerData.command, workerData.args, { ...workerData.options, stdio: 'pipe', windowsHide: true });
  let stopping = false;
  child.stdout.on('data', (data) => { if (!stopping) { child.stdout.pause(); port!.postMessage({ kind: 'stdout', data }); } });
  child.stderr.on('data', (data) => { if (!stopping) { child.stderr.pause(); port!.postMessage({ kind: 'stderr', data }); } });
  child.stdin.on('error', (error) => port!.postMessage({ kind: 'stdinError', message: error.message }));
  child.on('error', (error) => port!.postMessage({ kind: 'error', message: error.message }));
  child.on('close', (code, signal) => { port!.postMessage({ kind: 'exit', code, signal }); port!.close(); });
  port!.on('message', (message: { kind: string; data: Uint8Array; signal: NodeJS.Signals }) => {
    if (message.kind === 'write') child.stdin.write(message.data, () => port!.postMessage({ kind: 'written' }));
    if (message.kind === 'end') child.stdin.end();
    if (message.kind === 'kill') { stopping = true; child.stdout.resume(); child.stderr.resume(); child.kill(message.signal); }
    if (message.kind === 'resume') child.stdout.resume();
    if (message.kind === 'resumeError') child.stderr.resume();
  });
}

/** Spawns on a worker; keys are passed in memory to the child environment, never persisted. */
export function spawnCli(command: string, args: string[], options: CliSpawnOptions = {}): CliProcess {
  const proc = new EventEmitter() as CliProcess;
  proc.killed = false; proc.exitCode = null; proc.signalCode = null;
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  const { signal, ...workerOptions } = options;
  const worker = new Worker(`(${processWorker.toString()})()`, { eval: true, workerData: { command, args, options: workerOptions } });
  let ended = false;
  let written: ((error?: Error | null) => void) | undefined;
  const post = (message: object): void => { if (!ended) worker.postMessage(message); };
  proc.stdin = new Writable({
    write(data: Buffer, _encoding, callback) {
      if (ended) { callback(new Error('CLI process ended')); return; }
      written = callback;
      post({ kind: 'write', data });
    },
    final(callback) { post({ kind: 'end' }); callback(); },
  });
  proc.stdin.on('error', () => undefined);
  proc.kill = (killSignal = 'SIGTERM') => {
    if (ended) return false;
    proc.killed = true;
    post({ kind: 'kill', signal: killSignal });
    return true;
  };
  const abort = (): void => { proc.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const finish = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener('abort', abort);
    written?.(new Error('CLI process ended')); written = undefined;
    proc.exitCode = code; proc.signalCode = exitSignal;
    proc.stdout.end(); proc.stderr.end();
    proc.emit('exit', code, exitSignal);
    proc.emit('close', code, exitSignal);
  };
  worker.on('message', (message) => {
    if (message.kind === 'stdout') {
      if (proc.stdout.write(Buffer.from(message.data))) post({ kind: 'resume' });
      else proc.stdout.once('drain', () => post({ kind: 'resume' }));
    }
    if (message.kind === 'stderr') {
      if (proc.stderr.write(Buffer.from(message.data))) post({ kind: 'resumeError' });
      else proc.stderr.once('drain', () => post({ kind: 'resumeError' }));
    }
    if (message.kind === 'written') { const callback = written; written = undefined; callback?.(); }
    if (message.kind === 'stdinError') proc.stdin.destroy(new Error(message.message));
    if (message.kind === 'error') proc.emit('error', new Error(message.message));
    if (message.kind === 'exit') finish(message.code, message.signal);
  });
  worker.on('error', (error) => { proc.emit('error', error); finish(null, null); });
  worker.on('exit', (code) => finish(code, null));
  return proc;
}
