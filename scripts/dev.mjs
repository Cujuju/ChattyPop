// pnpm dev: electron-vite's dev flow, in parallel. A worker thread builds main and preload while this thread serves the
// renderer and pre-transforms it (server.warmup); `electron-vite dev` runs them one after the other on one thread.
// A splash shows from the start until the app shows its own (src/main/splash.ts). The app's restart rebuilds and reruns it here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { DEV_LAUNCH_ENV, RESTART_ARMED_MESSAGE, RESTART_CANCELLED_MESSAGE, SPLASH_SHOWN_MESSAGE } from '../src/shared/splash.mjs';

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
  // `pnpm dev -- --remote-debugging-port=9337`: pnpm passes the `--` through.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  /** The renderer server's URL: the first launch starts the server, restarts keep it. */
  let rendererUrl;

  /** Builds main and preload, then runs the app; the app's restart (src/main/restart.ts) runs this again. `start`: epoch ms. */
  const launchApp = async (start) => {
    /** The launch so far, for the splashes (src/shared/splash.mjs): its start and the steps done, epoch ms. */
    const launch = { start, done: {} };
    const splash = spawn(electron, [join(import.meta.dirname, 'devSplash.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...env, [DEV_LAUNCH_ENV]: JSON.stringify(launch) },
    });
    const finish = (id) => {
      launch.done[id] = Date.now();
      // It may already be gone (closed by hand).
      if (splash.connected) splash.send(id);
    };
    const fail = (err) => {
      console.error(err);
      splash.kill();
      process.exit(1);
    };
    const built = new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url));
      worker.on('message', finish);
      worker.on('error', reject);
      worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`The main and preload build exited with code ${code}.`))));
    });
    // A failed build ends the launch at once, even while the renderer server is still starting.
    built.catch(fail);
    try {
      if (!rendererUrl) {
        const server = await (await vite()).createServer((await devConfig()).renderer);
        await server.listen();
        server.printUrls();
        // electron-vite's form: no trailing slash; main loads it and appends queries and page names.
        rendererUrl = server.resolvedUrls.local[0].replace(/\/$/, '');
      }
      await built;
      finish('build');
    } catch (err) {
      fail(err);
    }
    const app = spawn(electron, ['.', ...args], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...env, ELECTRON_RENDERER_URL: rendererUrl, [DEV_LAUNCH_ENV]: JSON.stringify(launch) },
    });
    let restart = false;
    app.on('message', (m) => {
      if (m === SPLASH_SHOWN_MESSAGE) splash.kill();
      else if (m === RESTART_ARMED_MESSAGE) restart = true;
      else if (m === RESTART_CANCELLED_MESSAGE) restart = false;
    });
    app.on('close', (code) => {
      splash.kill();
      if (restart) void launchApp(Date.now());
      else process.exit(code ?? 0);
    });
  };
  await launchApp(performance.timeOrigin);
} else {
  const { build } = await vite();
  const { main, preload } = await devConfig();
  // Main's modules are parsed and linked at its buildEnd: most of the build. Rendering and preload follow.
  const compiled = { name: 'dev-launch-compiled', buildEnd: () => parentPort.postMessage('compile') };
  await build({ ...main, plugins: [...(main.plugins ?? []), compiled] });
  await build(preload);
}
