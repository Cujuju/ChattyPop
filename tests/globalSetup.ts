// Creates one temporary root per test run. Removes it after workers exit and close their databases.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { build } from 'vite';

/** Run folders are named `<prefix><pid>-<random>`: a run that crashed leaves one, and its pid tells whether it has ended. */
export const RUN_DIR_PREFIX = 'chattypop-test-run-';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's temp folder. */
    tempRoot: string;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

/** Retries EBUSY/EPERM cleanup failures with increasing 100 ms delays, allowing approximately 1.5 seconds for released Windows handles. */
const REMOVE_TRIES = 5;

/** Removes a folder; one still locked is left for the next run's sweep rather than failing this run. */
const remove = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: REMOVE_TRIES });
  } catch (err) {
    console.warn(`Couldn't remove test folder ${dir} (the next run retries): ${(err as Error).message}`);
  }
};

export default async function setup(project: TestProject): Promise<() => void> {
  // The electron package downloads its binary on first require; once here, so parallel workers don't race to fetch it.
  createRequire(import.meta.url)('electron');
  const repo = join(import.meta.dirname, '..');
  await build({
    configFile: false, logLevel: 'silent',
    resolve: { alias: { '@shared': join(repo, 'src/shared') } },
    build: { ssr: true, target: 'node24', outDir: join(repo, 'out/read-tests'), emptyOutDir: false,
      rollupOptions: { input: {
        archiveReadProcess: join(repo, 'src/core/reads/archiveReadProcess.ts'),
        archiveReadWorker: join(repo, 'src/core/reads/archiveReadWorker.ts'),
        archiveReadProbe: join(repo, 'tests/archiveReadProbe.ts'),
      }, external: [/^node:/, 'better-sqlite3-multiple-ciphers'], output: { format: 'es', entryFileNames: '[name].js' } },
    },
  });
  // Folders of runs that crashed before their teardown; a run still going (another checkout, another agent) keeps its own.
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const pid = Number(name.slice(RUN_DIR_PREFIX.length).split('-')[0]);
    if (Number.isInteger(pid) && !isAlive(pid)) remove(join(tmpdir(), name));
  }
  const root = mkdtempSync(join(tmpdir(), `${RUN_DIR_PREFIX}${process.pid}-`));
  project.provide('tempRoot', root);
  return () => remove(root);
}
