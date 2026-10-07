# ChattyPop

Electron + SolidJS desktop app: Discord archive, AI summaries, topic alerts, media-link feed, plugins.
Design and decisions: `docs/research.md` (read §0 Decisions and §10 UI architecture first).

# Architecture laws
1. **Redesign touches only the view layer.** Stores own data; panels (`src/renderer/src/panels/<id>/`) read stores only, never IPC; layout is data (`src/renderer/src/layout/`).
2. **No style literals outside `src/renderer/src/theme/`.** Colors, sizes, fonts, radii, shadows and durations are `--cp-*` tokens. Panels use CSS Modules. The theme owns how things look; a plugin's CSS modules hold structure only (layout and box geometry), and its look comes from the theme's look vocabulary (`look` in `@plugin-sdk/renderer`). `docs/plugin-architecture.md` §14 lists both property sets; a test enforces them.
3. **Styling ownership**: `src/renderer/src/theme/**` (the look vocabulary included) and `*.module.css` are authored by the design agent. Don't restyle in `.tsx`: a plugin applies vocabulary roles as classes and data attributes.
4. **Discord access** goes only through the embedded client: its session (`ses.fetch`, captured headers) and, for what the client itself sends there, its own gateway socket over CDP (`memberRequests.ts`: op 8 member search). Never Node `fetch` to discord.com or a second gateway connection.
5. **AI providers** sit behind one `LlmProvider` interface. Claude = Agent SDK → user's Claude Code; ChatGPT = `codex app-server`; Ollama/OpenRouter = OpenAI-compatible HTTP. Never read or store Claude/ChatGPT credentials.

# Commands
- `pnpm dev`: electron-vite dev in parallel (`scripts/dev.mjs`): main builds in a worker while the renderer server pre-transforms; a splash shows from the start
- `pnpm build`: build main/preload/renderer
- `pnpm typecheck`: TS type-check all targets
- `pnpm test`: vitest contract tests (`tests/`)
- `pnpm plugin:check <pluginDir>`: check a plugin folder against this checkout.
- `pnpm plugin:release-changed <pluginsRepoDir> --repo <owner/name> [--dry-run] [--only ids] [--sdk-rebuild]`: stamp and publish every changed plugin in a plugin repo; CI runs it on each push to the repo's main.

# Plugins
- The app holds no plugins. They live in plugin repos (`plugins/<id>/`, e.g. the built-in marketplace `Cujuju/ChattyPop-Plugins-Public`), with their tests; ships install them from a marketplace.
- Dev loop: set `CHATTYPOP_PLUGIN_DIRS` to your plugin clones' `plugins` folders (absolute paths, `;`-separated on Windows), then `pnpm dev`. Unset, the app runs with none (`docs/plugins.md`).
- Host tests use the rule probe, the read probe and fixture descriptors, never a real plugin.

# Stopping and restarting the app (agents)
The Discord login lives in the embedded session and is flushed to disk only on a graceful quit. A hard kill loses it.
- **Never** `Stop-Process`, `taskkill /F`, kill the `pnpm dev` terminal, or run `window.close()`/`app.quit()` via CDP.
- Close gracefully: send WM_CLOSE to the main window and wait. A bare WM_CLOSE quits even with Settings → Desktop → Close to the tray on (only the title-bar close hides). A window hidden in the tray has no `MainWindowHandle`: raise it first. The first close is often ignored, so try twice (run from the checkout):
  ```powershell
  foreach ($i in 1..2) { $p = Get-Process electron -EA 0 | ? { $_.Path -like "$PWD\*" -and $_.MainWindowHandle -ne 0 }; if (-not $p) { break }; [void]$p.CloseMainWindow(); $t = 0; while ($t -lt 12 -and (Get-Process -Id $p.Id -EA 0)) { Start-Sleep 1; $t++ } }
  ```
- Confirm no ChattyPop `electron` process remains, then relaunch with `pnpm dev` (`pnpm dev -- --remote-debugging-port=<port>` for CDP).
- The app profile (settings, Discord login, keys, whisper models) lives in `CHATTYPOP_PROFILE_DIR` when set, else AppData.
- Other sessions may be using the running app. Ask them before restarting it.

# Commits
- Commit your finished changes promptly, in small commits; don't leave work uncommitted.
- The commit type is the version bump (`appVersion.ts`): `feat` raises the minor number, every other type the patch. Nothing to edit by hand.
- Other agents share this checkout: stage only your exact paths, and coordinate with them before committing, reverting or reformatting files they are editing.

# Task tracking
- Tracker: **GitHub Issues** on this repo.
- Buckets: `area/ingest`, `area/storage`, `area/ai`, `area/ui`, `area/plugins`, `area/infra`.
- Kinds: `kind/spike`, `kind/feature`, `kind/bug`, `kind/chore`. Priority: `p1`, `p2`, `p3`.
- Arcs: `arc/<slug>` created on demand; never delete an arc label.
- Filters: active = `is:open label:p1,p2`; spikes = `is:open label:kind/spike`.
