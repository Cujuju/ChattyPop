// pnpm dev: electron-vite's dev flow, in parallel. A worker thread builds main and preload while this thread serves the
// renderer and pre-transforms it (server.warmup); `electron-vite dev` runs them one after the other on one thread.
// A splash shows from the start until the app shows its own (src/main/splash.ts).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import { SPLASH_SHOWN_MESSAGE } from '../src/shared/splash.mjs';

// electron-vite's dev server sets it before resolving its config; the config's helpers read it.
process.env.NODE_ENV_ELECTRON_VITE = 'development';
// Vite loads after the splash spawns: it takes most of a second.
const vite = () => import('vite');
const devConfig = async () => (await (await import('electron-vite')).resolveConfig({}, 'serve', 'development')).config;

if (isMainThread) {
  /** The Electron binary's path. */
  const electron = createRequire(import.meta.url)('electron');
  // Set in shells hosted by Electron apps; it would make the binary run as plain Node.
  const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;
  const splash = spawn(electron, [join(import.meta.dirname, 'devSplash.mjs')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env });
  const fail = (err) => {
    console.error(err);
    splash.kill();
    process.exit(1);
  };
  const built = new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    worker.on('error', reject);
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`The main and preload build exited with code ${code}.`))));
  });
  // A failed build ends the launch at once, even while the renderer server is still starting.
  built.catch(fail);
  try {
    const server = await (await vite()).createServer((await devConfig()).renderer);
    await server.listen();
    server.printUrls();
    // electron-vite's form: no trailing slash; main loads it and appends queries and page names.
    env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0].replace(/\/$/, '');
    await built;
    // The splash marks the step done; it may already be gone (closed by hand).
    if (splash.connected) splash.send('build');
  } catch (err) {
    fail(err);
  }
  // `pnpm dev -- --remote-debugging-port=9337`: pnpm passes the `--` through.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const app = spawn(electron, ['.', ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
  app.on('message', (m) => {
    if (m === SPLASH_SHOWN_MESSAGE) splash.kill();
  });
  app.on('close', (code) => {
    splash.kill();
    process.exit(code ?? 0);
  });
} else {
  const { build } = await vite();
  const { main, preload } = await devConfig();
  await build(main);
  await build(preload);
}
