import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCliAsync } from '../src/core/ai/asyncCli';
import { spawnCli } from '../src/core/ai/spawnCli';
import { IS_WINDOWS } from '../src/core/ai/resolveCli';
import { tempDir } from './helpers';

afterEach(() => vi.unstubAllEnvs());

describe('CLI discovery and spawning outside Core', () => {
  it.runIf(IS_WINDOWS)('follows npm shims, retries missing installs, and invalidates on refresh/PATH change', async () => {
    const dir = tempDir();
    vi.stubEnv('PATH', dir);
    expect(await resolveCliAsync('probe', 'probe')).toBeUndefined();
    writeFileSync(join(dir, 'probe.cmd'), '');
    writeFileSync(join(dir, 'node.exe'), '');
    const pkg = join(dir, 'node_modules', 'probe');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: 'cli.js' }));
    const expected = { command: join(dir, 'node.exe'), args: [join(pkg, 'cli.js')] };
    expect(await resolveCliAsync('probe', 'probe')).toEqual(expected);
    writeFileSync(join(dir, 'probe.exe'), '');
    expect(await resolveCliAsync('probe', 'probe')).toEqual(expected);
    expect(await resolveCliAsync('probe', 'probe', true)).toEqual({ command: join(dir, 'probe.exe'), args: [] });
    vi.stubEnv('PATH', tempDir());
    expect(await resolveCliAsync('probe', 'probe')).toBeUndefined();
  });

  it('relays stdio, EOF, environment and exit while Core keeps answering', async () => {
    const baseline = performance.now();
    const direct = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const nativeSpawnMs = performance.now() - baseline;
    await once(direct, 'exit');
    const dispatched = performance.now();
    const proc = spawnCli(process.execPath, ['-e', "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>{process.stderr.write(process.env.PROBE);});"], { env: { ...process.env, PROBE: 'private-test-value' } });
    const workerSpawnMs = performance.now() - dispatched;
    let output = '', errors = '';
    proc.stdout.on('data', (data) => { output += String(data); });
    proc.stderr.on('data', (data) => { errors += String(data); });
    const exit = once(proc, 'exit');
    proc.stdin.end('hello');
    let answered = false;
    await new Promise<void>((resolve) => setImmediate(() => { answered = true; resolve(); }));
    expect(answered).toBe(true);
    expect(await exit).toEqual([0, null]);
    expect(output).toBe('hello');
    expect(errors).toBe('private-test-value');
    process.stdout.write(JSON.stringify({ nativeSpawnMs, workerSpawnMs }) + '\n');
  });

  it('reports launch errors and cancels a process before its worker starts', async () => {
    const absent = spawnCli(join(tempDir(), 'missing'), []);
    absent.stdout.resume(); absent.stderr.resume();
    const error = await new Promise<Error>((resolve) => absent.once('error', resolve));
    expect(error.message).toContain('ENOENT');
    const stop = new AbortController();
    const held = spawnCli(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: stop.signal });
    held.stdout.resume(); held.stderr.resume();
    const exit = once(held, 'exit');
    stop.abort();
    await exit;
    expect(held.killed).toBe(true);
  });
});
