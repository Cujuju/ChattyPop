import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IS_WINDOWS, resolveCli } from '../src/core/ai/resolveCli';
import { tempDir } from './helpers';

let dir: string;
beforeEach(() => {
  dir = tempDir();
  vi.stubEnv('PATH', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(IS_WINDOWS)('CLI resolution (Windows)', () => {
  it('follows an npm shim to its JS bin, run by the Node beside it', () => {
    writeFileSync(join(dir, 'codex.cmd'), '@echo off');
    writeFileSync(join(dir, 'node.exe'), '');
    const pkg = join(dir, 'node_modules', '@openai', 'codex');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
    expect(resolveCli('codex', '@openai/codex')).toEqual({ command: join(dir, 'node.exe'), args: [join(pkg, 'bin/codex.js')] });
  });

  it('prefers a native executable', () => {
    writeFileSync(join(dir, 'claude.exe'), '');
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(resolveCli('claude', '@anthropic-ai/claude-code')).toEqual({ command: join(dir, 'claude.exe'), args: [] });
  });

  it('returns undefined when nothing is installed', () => {
    expect(resolveCli('codex', '@openai/codex')).toBeUndefined();
  });
});
