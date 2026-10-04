// Runs a TypeScript script with Vite's module runner (a dependency already): `node scripts/runTs.mjs <file.ts> ...args`.
// The script's `main(args)` export runs with the arguments after its path; its exit code is main's result.
import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const [file, ...args] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/runTs.mjs <script.ts> [args...]');
const { module } = await runnerImport(resolve(file), { configFile: false, logLevel: 'silent' });
if (typeof module.main !== 'function') throw new Error(`${file} exports no main(args)`);
process.exitCode = await module.main(args);
