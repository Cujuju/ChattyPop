// Runs a TypeScript module through Vite’s runner. Calls main(args) with remaining arguments and uses its result as the exit code.
import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const [file, ...args] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/runTs.mjs <script.ts> [args...]');
const { module } = await runnerImport(resolve(file), { configFile: false, logLevel: 'silent' });
if (typeof module.main !== 'function') throw new Error(`${file} exports no main(args)`);
process.exitCode = await module.main(args);
