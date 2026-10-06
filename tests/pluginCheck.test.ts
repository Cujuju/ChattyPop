// External-plugin checks pass valid fixtures and fail planted faults at their respective steps with nonzero exits.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEPS, type Step } from '../scripts/pluginCheck';
import { tempDir } from './helpers';
import { HOST_TESTING_FILES } from './hostTesting/files';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(import.meta.dirname, 'fixtures/checkprobe');
/** A full check runs two type-checks, two Vite builds and a vitest run, each in this process's children. */
const CHECK_TIMEOUT_MS = 180_000;

/** The fixture's id, which names its folder. */
const FIXTURE_ID = 'checkprobe';

/** The fixture copied to a temp folder `name` (outside the checkout, as a plugin repo is), with `faults` written over it. */
function pluginFolder(faults: Record<string, string> = {}, name = FIXTURE_ID): string {
  const dir = join(tempDir(), name);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, text] of Object.entries(faults)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** Runs the CLI as `pnpm plugin:check` does; its exit code and output. */
function check(dir: string): Promise<{ code: number; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['scripts/runTs.mjs', 'scripts/pluginCheck.ts', dir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (b: Buffer) => (output += b));
    child.stderr.on('data', (b: Buffer) => (output += b));
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? 1, output }));
  });
}

/** Every step before `failed` passed, `failed` failed, and none after it ran. */
function expectFailedAt(r: { code: number; output: string }, failed: Step): void {
  expect(r.code, r.output).not.toBe(0);
  const at = STEPS.indexOf(failed);
  for (const step of STEPS.slice(0, at)) expect(r.output).toContain(`plugin:check ${step}: ok`);
  expect(r.output).toContain(`plugin:check failed at ${failed}:`);
  for (const step of STEPS.slice(at + 1)) expect(r.output).not.toContain(`plugin:check ${step}`);
}

describe('pnpm plugin:check', () => {
  it('passes a sound plugin folder through every step', { timeout: CHECK_TIMEOUT_MS }, async () => {
    const r = await check(pluginFolder());
    expect(r.code, r.output).toBe(0);
    for (const step of STEPS) expect(r.output).toContain(`plugin:check ${step}: ok`);
  });

  it.each(['shared/broken.ts', 'page/broken.ts'])('fails a type error at typecheck: %s', { timeout: CHECK_TIMEOUT_MS }, async (file) => {
    const r = await check(pluginFolder({ [file]: "export const count: number = 'many';\n" }));
    expectFailedAt(r, 'typecheck');
    expect(r.output).toContain(file);
  });

  it('fails a look declaration at styles', { timeout: CHECK_TIMEOUT_MS }, async () => {
    const r = await check(pluginFolder({ 'renderer/Broken.module.css': '.line {\n  color: var(--cp-text-muted);\n}\n' }));
    expectFailedAt(r, 'styles');
    expect(r.output).toContain('Broken.module.css');
  });

  it('fails source-rule violations at scan, naming each by file and line', { timeout: CHECK_TIMEOUT_MS }, async () => {
    const r = await check(pluginFolder({
      'core/net.ts': "// Through the global, not ctx.net.\nexport const get = (): Promise<Response> => fetch('https://example.com');\n",
      'shared/table.ts': "export const ROWS = 'p_checkprobe_rows';\n",
    }));
    expectFailedAt(r, 'scan');
    expect(r.output).toContain('core/net.ts:2: fetch:');
    expect(r.output).toContain('shared/table.ts:1: literal table prefix p_checkprobe_');
  });

  it('fails a folder not named by its id at scan, whose rules key on the id', { timeout: CHECK_TIMEOUT_MS }, async () => {
    const r = await check(pluginFolder({}, `${FIXTURE_ID}2`));
    expectFailedAt(r, 'scan');
    expect(r.output).toContain(`its descriptor's id is ${FIXTURE_ID}`);
  });

  it('fails a failing plugin test at tests', { timeout: CHECK_TIMEOUT_MS }, async () => {
    const r = await check(pluginFolder({ 'tests/broken.test.ts': "import { expect, it } from 'vitest';\n\nit('breaks', () => expect(1).toBe(2));\n" }));
    expectFailedAt(r, 'tests');
  });
});

describe('tsconfig.plugin.json', () => {
  /** A repo config's path mappings, as tsc resolves them. */
  const pathsOf = (config: string): Record<string, string[]> => {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', config, '--showConfig'], { cwd: ROOT, encoding: 'utf8' });
    return (JSON.parse(r.stdout) as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths;
  };

  it("maps every alias the node and browser configs map, to the same place, so a plugin outside resolves the SDK's imports", () => {
    const plugin = pathsOf('tsconfig.plugin.json');
    for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) {
      for (const [alias, targets] of Object.entries(pathsOf(config))) expect(plugin[alias], `${config} ${alias}`).toEqual(targets);
    }
  });
});

describe('the host test kit', () => {
  /** A module's relative import specifiers. */
  const relativeImports = (file: string): string[] =>
    [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+'(\.[^']+)'/g)].map((m) => m[1]!);
  /** The file a relative specifier names: a .ts or .tsx file, a folder's index, or the path as written. */
  const resolveFrom = (from: string, spec: string): string => {
    const base = resolve(dirname(from), spec);
    return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((p) => existsSync(p)) ?? base;
  };

  it('reaches only files in this checkout that exist, from its index and each helper served by name, so it loads in a checkout with no plugins', () => {
    const tests = join(ROOT, 'tests');
    const seen = new Set<string>();
    const reached: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of relativeImports(file)) {
        const target = resolveFrom(file, spec);
        if (!target.startsWith(ROOT) || !existsSync(target)) reached.push(`${file} imports ${spec}`);
        else if (target.startsWith(tests)) walk(target);
      }
    };
    for (const entry of ['hostTesting/index.ts', ...HOST_TESTING_FILES.map((f) => `${f}.ts`)]) {
      expect(existsSync(join(tests, entry)), entry).toBe(true);
      walk(join(tests, entry));
    }
    expect(seen.size).toBeGreaterThan(HOST_TESTING_FILES.length + 1);
    expect(reached).toEqual([]);
  });
});
