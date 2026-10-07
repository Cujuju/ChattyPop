# ChattyPop

Electron + SolidJS desktop app: Discord archive, AI summaries, topic alerts, media-link feed, plugins.
Design and decisions: `docs/research.md` (read §0 Decisions and §10 UI architecture first).

# Architecture laws
1. **Redesign touches only the view layer.** Stores own data; panels (`src/renderer/src/panels/<id>/`) read stores only, never IPC; layout is data (`src/renderer/src/layout/`).
2. **No style literals outside `src/renderer/src/theme/`.** Colors, sizes, fonts, radii, shadows and durations are `--cp-*` tokens. Panels use CSS Modules.
3. **Styling ownership**: `src/renderer/src/theme/**` and `*.module.css` are authored by the design agent. Don't restyle in `.tsx`.
4. **Discord access** goes only through the embedded client's session (`ses.fetch`, captured headers). Never Node `fetch` to discord.com.
5. **AI providers** sit behind one `LlmProvider` interface. Claude = Agent SDK → user's Claude Code; ChatGPT = `codex app-server`; Ollama/OpenRouter = OpenAI-compatible HTTP. Never read or store Claude/ChatGPT credentials.

# Commands
- `pnpm dev`: electron-vite dev in parallel (`scripts/dev.mjs`): main builds in a worker while the renderer server pre-transforms; a splash shows from the start
- `pnpm build`: build main/preload/renderer
- `pnpm typecheck`: TS type-check all targets
- `pnpm test`: vitest contract tests (`tests/`)

# Stopping and restarting the app (agents)
The Discord login lives in the embedded session and is flushed to disk only on a graceful quit. A hard kill loses it.
- **Never** `Stop-Process`, `taskkill /F`, kill the `pnpm dev` terminal, or run `window.close()`/`app.quit()` via CDP.
- Close gracefully: send WM_CLOSE to the main window and wait. The first close is often ignored, so try twice (run from the checkout):
  ```powershell
  foreach ($i in 1..2) { $p = Get-Process electron -EA 0 | ? { $_.Path -like "$PWD\*" -and $_.MainWindowHandle -ne 0 }; if (-not $p) { break }; [void]$p.CloseMainWindow(); $t = 0; while ($t -lt 12 -and (Get-Process -Id $p.Id -EA 0)) { Start-Sleep 1; $t++ } }
  ```
- Confirm no ChattyPop `electron` process remains, then relaunch with `pnpm dev` (`pnpm dev -- --remote-debugging-port=<port>` for CDP).
- Other sessions may be using the running app. Ask them before restarting it.

# Task tracking
- Tracker: **GitHub Issues** on this repo.
- Buckets: `area/ingest`, `area/storage`, `area/ai`, `area/ui`, `area/plugins`, `area/infra`.
- Kinds: `kind/spike`, `kind/feature`, `kind/bug`, `kind/chore`. Priority: `p1`, `p2`, `p3`.
- Arcs: `arc/<slug>` created on demand; never delete an arc label.
- Filters: active = `is:open label:p1,p2`; spikes = `is:open label:kind/spike`.
