# Startup playbook: a fast dev launch and an honest splash

How ChattyPop's dev launch (`pnpm dev`) went from about 31 s to about 12.7 s to first content, how its startup splash came to show real progress and the user's theme, and how its first paint stopped flashing a default layout. The steps apply to any Electron + Vite app (electron-vite, a SolidJS or React renderer); the ChattyPop files are named so you can read working code.

| Measured from a shortcut click | Before | After |
|---|---|---|
| Something visible on screen | ~30 s (nothing until the window) | ~2 s (splash) |
| Renderer DOMContentLoaded, from navigation | 13.0 s | 1.2 s |
| App content on screen | ~31 s | ~12.7 s |
| First paint | default layout, then the saved one | saved layout only |

Constraint kept throughout: the dev build stays a dev build (Vite dev server, HMR). A cached production build was considered and rejected.

---

## 1. Measure first

Don't guess where startup time goes. Get one timeline across every process, from a cold launch.

1. **Timestamp each process to one file.** Add temporary lines like `appendFileSync('E:/boot.log', `${Date.now()} main whenReady\n`)`:
   - in the main entry (with `process.uptime()`), at `whenReady`, around window creation, at `ready-to-show` and `did-finish-load`;
   - in any utility process, between each init step, with the delta from the last step;
   - for the launch itself: write the click time to the same file just before starting the shortcut.

   Revert all of it afterwards; never commit it.
2. **Renderer marks over CDP.** Launch with `--remote-debugging-port`, then read `performance.timeOrigin`, the navigation entry (`responseEnd`, `domContentLoadedEventEnd`), the paint entries and your own `performance.mark()`s through `Runtime.evaluate`. `timeOrigin` places the renderer on the same wall clock as the boot log.
3. **Read the dev server's log.** electron-vite prints `built in Xs` per target; compare it with the boot log's gaps.
4. **Reproduce each phase alone**, so you can change one thing at a time:
   - **Main build:** a copy of the config that forces dev plugin sources, built with `--outDir` pointed at a temp folder. Never overwrite `out/` while the app runs.
   - **Renderer transforms:** a script that resolves the renderer config (`resolveConfig({}, 'serve', 'development')` from electron-vite) and starts a Vite server in `middlewareMode`. It wraps each plugin's `transform`, `resolveId` and `load` hooks with timers, then walks the graph from the entry (`server.transformRequest(url)`, then `moduleGraph.getModuleByUrl(url).importedModules`). It reports the module count, the total time, time per plugin and modules per folder.
5. **Check the machine.** Count the cores (`nproc`). Time the fixed costs (`pwsh -Command exit`, `pnpm -v`, `electron --version`).

**What ChattyPop's timeline showed (cold launch):**

| Phase | Time |
|---|---|
| Shell + pnpm + electron-vite start | ~3.5–5 s |
| main/core/preload build, with dev plugin folders | 10.8 s cold, 4.4 s warm |
| Electron start → window created | ~0.6 s |
| Core init (DB, plugins) | ~1.5 s, finished before the renderer needed it |
| Renderer: Vite transforms ~756 modules on request | 13.1 s |
| First paint waiting on settings | 0.5 s |

The key fact: `electron-vite dev` runs **build main → build preload → start the renderer server → start Electron**, in series, on **one Node thread**. Renderer modules are then transformed on demand as the browser discovers imports. The machine had 32 cores.

## 2. Parallelize the dev launch (`scripts/dev.mjs`)

Replace `electron-vite dev` with a small launcher built on electron-vite's and Vite's public APIs:

- **A worker thread** resolves the config and runs `vite.build(config.main)` then `vite.build(config.preload)`.
- **The main thread** starts the renderer server (`vite.createServer(config.renderer)`, then `listen()`) with `server.warmup.clientFiles` set to the renderer entry. Vite transforms the whole static import graph as soon as the server listens, at the same time as the build.
- When the build settles, set `ELECTRON_RENDERER_URL` (from `server.resolvedUrls.local[0]`, trailing slash removed) and spawn Electron.

```js
process.env.NODE_ENV_ELECTRON_VITE = 'development';       // electron-vite's config helpers read it
const devConfig = async () => (await (await import('electron-vite')).resolveConfig({}, 'serve', 'development')).config;
if (isMainThread) {
  const built = new Promise((ok, fail) => { const w = new Worker(new URL(import.meta.url)); w.on('error', fail); w.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`build exited ${c}`)))); });
  built.catch(die);                                        // a failed build ends the launch at once
  const server = await (await import('vite')).createServer((await devConfig()).renderer);
  await server.listen();
  env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0].replace(/\/$/, '');
  await built;
  const app = spawn(electronPath, ['.', ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
  app.on('close', (code) => process.exit(code ?? 0));
} else {
  const { build } = await import('vite');
  const { main, preload } = await devConfig();
  await build(main); await build(preload);
}
```

Details that matter:
- `package.json`: `"dev": "node scripts/dev.mjs"`. pnpm passes a literal `--` through, so filter it out of the Electron arguments: `pnpm dev -- --remote-debugging-port=9337` still works.
- **Strip `ELECTRON_RUN_AS_NODE`** from the environment you spawn Electron with. Shells hosted by Electron apps (editors, agent hosts) set it, and it turns the binary into plain Node.
- **`process.chdir` throws in workers.** Do it on the main thread only; the working directory is process-wide.
- **Import Vite lazily** (`await import('vite')`) after spawning anything that should appear early: loading Vite takes most of a second.
- Electron's path is `createRequire(import.meta.url)('electron')`.

**Result:** the build (5–6 s) and the renderer warm-up (~6 s) now overlap. The window loads from a warm server, so its DOMContentLoaded went from 13 s to about 1 s. Isolated measurement: both finished in ~6.2 s, against ~4.4 s + ~13 s in series.

**What did not help, or was rejected:**
- **Externalizing plugin `node_modules` in the main build.** electron-vite's own externals config overrode it; the warm build is ~4 s anyway.
- **A cached production build** for daily launches. It's fast, but gives up the dev build; rejected.
- **HTTP/2 for the dev server**, to lift the 6-connection limit. Not the bottleneck: a warm reload of the same ~756 modules took 0.5 s.

Remaining levers (not done):
- Lazy-load views the first paint doesn't need (settings dialogs etc.), which shrinks the startup module graph.
- Build the heaviest main-process entry in its own parallel build.

## 3. No flash of default state on the first paint

**Symptom:** the window drew the default layout, then swapped to the saved custom one.

**Root cause:** every persisted setting started at its fallback value and adopted the stored one only after an async IPC round trip. That trip also queued behind the backend's synchronous init. The first render used the fallbacks. A second source: the plugin list arrived late, so a disabled plugin's panels showed, then vanished.

**Fix, at the settings contract rather than per setting:**
- A small registry, `src/plugin-sdk/renderer/firstPaint.ts`:
  - `holdFirstPaint(promise)` adds a read the first paint must wait for;
  - `firstPaintReady()` uses `Promise.allSettled` over the reads registered so far, and releases the hold so later reads don't join.
- The setting factory (`createSetting`) holds the first paint on its stored-value read; the plugin-list fetch does too.
- The entry renders after `await firstPaintReady()`. Failed reads still let it paint, on fallbacks.

Everything created at import time is covered automatically. Settings created later (lazily loaded plugins) adopt their value on arrival; that remaining gap is documented.

**Verify it** with a `MutationObserver` injected by `Page.addScriptToEvaluateOnNewDocument`, which logs each distinct set of rendered panels across a `Page.reload`. Before the fix it logged 4 sets; after, 1.

## 4. The splash

### Two stages, one look
- **Before Electron exists** (dev only: the build runs first), the launcher spawns a tiny Electron process, `scripts/devSplash.mjs`, as its very first act. It has its own throwaway `userData`, so it never touches the app's profile and doesn't contend for its single-instance lock.
- **Inside the app** (dev and packaged), main opens the same splash right after creating the hidden main window (`src/main/splash.ts`).
- **Handoff:** the launcher spawns the app with an `'ipc'` stdio channel. Once the app's splash is on screen, the app calls `process.send(SPLASH_SHOWN_MESSAGE)`, and the launcher kills its splash. The two windows are identical and centred, so the swap is invisible. Electron's main process gets `process.send` when it is spawned with an IPC channel; in a packaged app it's undefined, so the call is a no-op.
- **Close:** the app's splash closes on the main window's first `show`, and also on its `closed`. A start hidden in the tray shows no splash.

### Share the code with plain JS
The launcher runs before any build, so it can't import TypeScript. Put the contract and the window driver in plain ES modules, each with a `.d.mts` beside it so TypeScript gets the types:
- `src/shared/splash.mjs`: the window options, the step list, the theme tokens, the profile file names, the handoff message and `splashProgress` (the bar's position).
- `src/main/splashWindow.mjs`: `openSplash`, and reading and writing the saved theme and timeline.

Vite bundles them into the app; the launcher's splash imports them directly. Any custom import-graph tooling you have, test helpers included, must follow `.mjs`.

### A static page driven from main
- `src/renderer/splash.html` has **no script**, just markup with ids, and a CSP of `default-src 'none'; style-src 'self'; img-src 'self' data:`. Vite inlines small images as `data:` URIs in the production build, so allow `data:`.
- It's loaded with `loadFile`, from the source folder in dev and from `out/renderer` when packaged. Loading from disk keeps it off a dev server that is busy warming up. Add it as a Vite build input, and reserve the page name, so a plugin page can't replace it.
- Main drives it with `webContents.executeJavaScript(`(${wear})(${JSON.stringify(state)})`)`. `wear` is a self-contained function serialized with `toString()`. It sets the theme properties on `<html>`, the status text and the bar's progress variable, then waits two `requestAnimationFrame`s. `executeJavaScript` is not subject to the page's CSP.
- **Show after the first themed paint, not on `ready-to-show`.** On `did-finish-load`, run `wear`, await it, then `show()`. `ready-to-show` would show the default look first.
- **Loops phased to the launch start.** Two splash windows show in turn (the launcher's, then the app's on top), so a loop that restarts at the handoff jumps. The first `wear` sets `--splash-clock` (minus the ms since the launch start) and `data-splash-clock` on `<html>`, once; every loop (the icon's breath, the bar's sweep) runs only under that attribute, with the clock as its `animation-delay`. Setting the delay after a loop started would shift it, hence the gate. No entrance animation: it would replay at the handoff.
- Styles live with the theme (ChattyPop: `theme/splash.css`, written by the design agent). It must load raw from disk, so use relative `@import`s only, and only of token files that have no package imports.

### Progress from real milestones
A list of steps. Each completes on an event that really happens:

| Step | Completes when |
|---|---|
| Compiling the app (dev only) | main's build reaches Rollup's `buildEnd` (posted by the build worker, sent over the splash's IPC channel) |
| Bundling the app (dev only) | the launcher's builds settle |
| Starting the app | main's process is up: done as the app's splash opens |
| Starting the archive | the backend process has loaded its code: its message handler gets the init main posted at fork, and posts `init-step` back |
| Opening the database | the backend opened the database (key and migrations included) and posted `init-step` |
| Preparing rules and plugins | the backend answers its first request: its init is synchronous, so requests queue behind it |
| Loading the interface | the main window's `did-finish-load` (module scripts have run) |
| Opening the window | the main window shows; the splash closes |

- **Status:** the first step not done, so steps that finish in parallel and out of order are fine.
- The dev launcher's splash buffers steps that arrive before its window exists. The app's splash starts with the dev-only step already done.

### A bar weighted by the last launch
Equal steps stall: in ChattyPop the build is over half the launch, and the last two steps take under a second. So the bar is placed by time:
- **Timeline:** when every step is done, the app saves each step's finish time, in ms from the launch start, to `splash-timeline.json` in the profile. It's kept per mode (dev, release), since their timelines differ. In dev the launch starts when the launcher starts (`performance.timeOrigin`); the launcher passes its start and the steps it finished to its splash and the app in an environment variable (`DEV_LAUNCH_ENV`). Only the app writes the file.
- **Position** (`splashProgress`): each step ends on the bar where it finished last time (its time ÷ the last step's). The bar sits at the furthest finished step's end. With no full timeline (a first run, or the first launch after a step is added), steps are spaced evenly.
- **Glide:** while a step runs, the bar glides linearly toward it, over the time it's expected to take (its last-launch time minus the time elapsed), stopping at `SPLASH_GLIDE_SHARE` (90%) of the way: only the step finishing fills the rest. An overdue step gets no glide. Main sets `--splash-done`, `--splash-glide` and `--splash-glide-ms`; the CSS registers them with `@property` and transitions the properties themselves (not `width`), only once `data-splash-live` is set after the first paint, so a splash that takes over mid-launch doesn't re-fill from 0. Reduced motion shows finished work only.
- **Split long steps at real events.** The dev build's `compile` step ends at main's Rollup `buildEnd` (a plugin hook in the worker that posts to the launcher), and `build` when both builds finish. The backend's init posts its milestones (`CoreInitStepMessage`) beside its events; main maps each to a step.
- **Why not count work?** We tried a per-module count (`moduleParsed`) as the build's progress. It misled: one 1.1 MB dependency parses last and is then tree-shaken, about 2 s with no hook firing, so the count reached 99% with half the build to go. Measure where the time goes before trusting a counter.

### Themed from the last session
- **Save:** whenever the main window applies a theme, it reads the resolved values of the tokens the splash uses (`getComputedStyle(documentElement).getPropertyValue(token)`). It sends them over IPC; only the main window's sender is accepted. Main validates them and writes `splash-theme.json` to the profile only when they changed. Validation keeps known token names only, values within a length cap, and colour characters only: no `url(`, quotes, `;` or braces.
- **Read:** at launch, synchronously, before the splash opens. The dev splash finds the profile the way the app does: the profile-directory environment variable when set, else Electron's `appData` + the package name. Missing or invalid data means the default look.
- Resolved values, rather than a theme id, make custom themes work with no extra code.

## 5. Pitfalls met

- **`ready-to-show` is not "content is on screen".** It fires on the first paint, which can be blank or unthemed.
- **Never hard-kill an app that keeps a login in its session storage.** Close it gracefully (WM_CLOSE to the main window, twice if needed). Hard-killing only your own throwaway splash process is fine.
- **Don't edit main-process sources while a dev app runs** if your launcher watches and restarts. Close the app first.
- **Line endings:** Python's text-mode writes on Windows turn LF into CRLF. Write bytes.
- **Vite won't bundle a classic `<script src>`** (only `type="module"`, which is deferred and runs after the first paint). Another reason the splash has no script.
- **Unhandled rejections in tests:** a factory that returns a `loaded` promise which rejects needs a `.catch` in the test.

## 6. Checklist for another app

1. Measure a cold launch: a boot log across processes, renderer marks over CDP, the dev server log, and each phase reproduced alone.
2. If the dev launcher runs the build and the dev server one after the other: write `scripts/dev.mjs` (worker build plus main-thread server with `warmup`), and point `"dev"` at it.
3. Gate the first render on persisted state at the settings-factory level (`holdFirstPaint` / `firstPaintReady`).
4. Add the splash:
   - a static page;
   - a plain-JS contract and driver with `.d.mts` types;
   - an app splash opened right after the hidden main window;
   - a launcher splash spawned first;
   - the handoff over IPC.
5. Pick 3–5 real milestones, and mark each where it happens. Save their times, place them on the bar by the last launch, and glide toward the next. Split the longest step at real events.
6. Persist the resolved theme tokens on each theme change; read them synchronously at the next launch, and validate both ways.
7. Verify:
   - typecheck and tests;
   - a production build (the splash page emitted, its assets allowed by the CSP);
   - a live launch, sampling the splash's status and theme over CDP and checking that no splash process is left behind.

Code: `scripts/dev.mjs`, `scripts/devSplash.mjs`, `src/main/splash.ts`, `src/main/splashWindow.mjs`, `src/shared/splash.mjs`, `src/renderer/splash.html`, `src/renderer/src/theme/splash.css`, `src/plugin-sdk/renderer/firstPaint.ts`, `src/renderer/src/state/desktop.ts` (`syncSplashTheme`). Tests: `tests/firstPaint.test.ts`, `tests/splashTheme.test.ts`, `tests/splashProgress.test.ts`.
