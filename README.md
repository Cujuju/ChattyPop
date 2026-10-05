# ChattyPop

> [!CAUTION]
> ### Unofficial client. Use at your own risk.
> **ChattyPop is not made by, affiliated with or endorsed by Discord.** It reads Discord with your own user account, through the embedded Discord web client. Automating a user account is against Discord's Terms of Service, and Discord may suspend or ban accounts that do it. You alone are responsible for how you use it. It is provided as is, without warranty of any kind (see [LICENSE](LICENSE)).

A Windows desktop app beside the Discord web client. It archives the channels you choose, summarizes them with AI, alerts on topics you care about, and collects every shared link into a browsable feed.

## What it does
- **Archive**: opt in per channel, thread, forum or DM. Live messages come from the embedded Discord client; background sync catches up and backfills. Edits and deletions keep the original. Attachments are downloaded into a deduplicated local store.
- **Summaries** with citations that open the source message: Claude (your Claude Code), ChatGPT (your Codex CLI), Ollama or OpenRouter.
- **Topics and alerts**: keywords, regex or a plain-language description (Jev). Alerts go to an inbox, with optional Windows notifications.
- **Links**: every shared link with Discord's preview card, filterable by platform, channel and date.
- **Search**: full text with `from:`, `in:`, `has:`, `before:` and `after:`.
- **Storage control**: attachment and database size caps, text retention tiers, per-channel policies (local-AI-only, own tier), a startup re-check for edits and deletions, move the archive to another folder, optional database encryption.
- **Exchange**: export to HTML or DiscordChatExporter JSON; import DiscordChatExporter JSON.
- **Layouts**: Stack, Side, Tabs, or your own (drag or right-click panel headers); collapsible panels and sidebar.
- **Plugins**: full-trust ES modules with core hooks and their own panels ([docs/plugins.md](docs/plugins.md)).


## Install
Download `ChattyPop-Setup-<version>.exe` from [Releases](https://github.com/Cujuju/ChattyPop/releases/latest) and run it. The installer is unsigned, so Windows SmartScreen may warn on first run: **More info → Run anyway**. Installed copies update themselves from new releases (Settings → Desktop).

## Requirements (to build)
- Windows 10 or 11, Node.js 24, pnpm.
- For AI (all optional): Claude Code and/or the Codex CLI signed in on your PATH, Ollama running locally, or an OpenRouter key (Settings → AI).

## Commands
| Command | |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run in development |
| `pnpm typecheck` | Type-check main, preload, core and renderer |
| `pnpm test` | Contract tests (vitest, `tests/`) |
| `pnpm build` | Build main, preload, core and renderer |
| `pnpm dist` | Build the NSIS installer into `release/` (unsigned) |

## Releasing
CI (`.github/workflows/ci.yml`) type-checks, tests and builds every push and pull request. A release publishes the installer and `latest.yml`, which installed copies update from, tagged `v<version>`. The version comes from git history (`appVersion.ts`), so each commit has its own. To release:
- **Actions → Release app → Run workflow** releases the head of `main`, or
- push a tag naming a commit's version: `node scripts/runTs.mjs scripts/printVersion.ts` prints it, then `git tag v<version>` and `git push origin v<version>`.

The workflow refuses a version that is already released, and a tag that isn't its commit's version. A push to `main` that changes `PLUGIN_SDK_VERSION` releases the app on its own once CI passes, since plugin repos build against `main` and their new releases need an app with that SDK.

## Where things live
- Archive (database and media): Settings → Archive → Location (default: the app profile). The folder is set in `%APPDATA%\chattypop\storage.json`.
- App profile (Discord login, secrets encrypted with Windows DPAPI, plugins): `%APPDATA%\chattypop`.

## Code
Electron main (windows, Discord capture, secrets), a core utility process (SQLite, sync, AI, plugins) and a SolidJS renderer. Design notes and decisions: [docs/research.md](docs/research.md). Project rules: [CLAUDE.md](CLAUDE.md).
