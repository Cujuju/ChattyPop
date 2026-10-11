# Discord bot: research

Researched 2026-10-11 against this checkout (base commit `a9cdb21`). Research only; no code was changed.

Question (owner): What would be required to turn the archive and AI functionality of this application into a Discord bot?

Scope: this repository only. The Summaries, Alerts and AI-provider plugins live in `Cujuju/ChattyPop-Plugins-Public`, which was not read; what is said about them comes from this repository's docs.

## 1. Conflicts with the project's decisions

- `docs/research.md` §0 Decisions: "Discord access | **User account (not bot)**."
- `CLAUDE.md` law 4: "Discord access goes only through the embedded client's session (`ses.fetch`, captured headers) ... Never Node `fetch` to discord.com, gateway socket discovery/injection, or a second gateway connection."
- `docs/research.md` §0 Rules: "No background running: closed means closed."

A bot needs its own gateway connection, Bot-token REST calls, and a process that keeps running. All three break these rules, so a bot is either a fork or a change to the laws, not just a feature.

## 2. What can be reused

| Component | Evidence | Reuse |
|---|---|---|
| SQLite archive, migrations, retention | `docs/research.md` §4: "`better-sqlite3-multiple-ciphers` ... It's Node-API"; `src/core/db.ts` imports only `better-sqlite3-multiple-ciphers` and node modules | Yes. Runs in plain Node. |
| Message ingest | `src/core/archive.ts` `class Archive`: `ingestMessages(messages: RawMessage[], via)`, `ingestSyncPage(...)`, `applyUpdate(...)`, `markDeleted(...)` | Yes. Takes raw Discord message objects. |
| Gateway event application | `src/core/gatewayEvents.ts` `applyGatewayEvent(a, t, d, deps)`; event list in `src/shared/types/ipc.ts` `ARCHIVED_GATEWAY_EVENTS` | Partly. `MESSAGE_*` and `MESSAGE_REACTION_*` payloads are standard. `READY` handling reads `r.merged_members` and `READY_SUPPLEMENTAL`, which are user-client fields. |
| AI provider interface | `src/core/ai/types.ts` `interface LlmProvider { complete(req): Promise<CompletionResult>; planUsage?(); listModels() }` | Yes. |
| Rules engine, Jev | `src/core/rules/*`, `src/core/jev/*`, created in `src/core/index.ts` | Yes, but the single "self" concept needs rework (section 3.5). |
| Channel visibility facts | `src/core/access.ts`: "What decides who can see a channel ... each server's owner and each channel's overwrites, as the gateway reports them" | Needed for per-requester permission checks. Whether it fits a bot's needs: [unverified]. |

## 3. Required changes

### 3.1 Process host (Electron removal from core)
- `src/core/index.ts` header: "Electron utility process owning SQLite, AI and core plugins." All requests and events go through `process.parentPort.on('message', ...)` and `process.parentPort.postMessage(...)`. Replace this with a plain Node entry point that calls `handlers[...]` directly or over IPC.
- `src/core/index.ts` imports `installedStart` from `@main/plugins/installed/runtime`. That file's imports are Node-only (`node:module`, `node:path`) plus `@shared`, so it can be moved.
- The utility process is started from main: `src/main/coreClient.ts` calls `utilityProcess.fork(entry, ...)`. The bot needs its own launcher.

### 3.2 Discord access: replace every user-session component
| File | Current behaviour (quote) | Bot replacement |
|---|---|---|
| `src/main/discord/api.ts` | "Runs fetch() inside the embedded Discord page"; `API_BASE = 'https://discord.com/api/v9/'` | REST v10 with `Authorization: Bot <token>`, from Node (discord.js, or a small client that keeps the existing `RateLimits` logic) |
| `src/main/discord/capture.ts` | "Observes the embedded client's own API traffic: captures auth headers" | Delete. The token comes from config or env. |
| `src/main/discord/gatewayTap.ts` | "Reads the embedded client's own gateway traffic through CDP; sends nothing to Discord." | Own gateway connection with intents `GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT` (privileged), `GUILD_MESSAGE_REACTIONS`, and `GUILD_MEMBERS` (privileged) for member data. |
| `src/main/sync/syncService.ts` | "channels/{id}/threads/search response (user accounts can't use the bot-only thread list endpoints)"; `CLIENT_PAGE_SIZE = 50` "observed from the Discord web client" | Bot thread endpoints (`guilds/{id}/threads/active`, `channels/{id}/threads/archived/public` and `/private`). Page size can be raised to 100 (`docs/research.md` §1: "DCE uses v10" and 100). |
| `src/main/media/attachmentDownloader.ts`, `cdnCache.ts`, `thumbStore.ts` | These import `electron` | Plain Node HTTP to the CDN |
| `src/main/secretFile.ts` | `safeStorage.encryptString(value)` | Secret store for the bot token, Jev/OpenRouter keys and the archive key (env, OS keyring, or a KMS) |

Bot-specific behaviour changes:
- Without the `MESSAGE_CONTENT` intent, message text is empty. `docs/research.md` §5: "An all-empty `content` batch means missing MESSAGE_CONTENT (bots only)."
- A bot sees only guilds it was invited to and channels its role can read. Per-channel opt-in (`Archive.setOptIn`) remains but becomes an admin command.
- The owner's DMs cannot be archived. A bot only sees DMs sent to the bot. The DM features in `docs/dms.md` and `src/main/discord/dms.ts` do not carry over.
- The composer, interactions, GIF picker and posting-as-the-user code is irrelevant to a bot (`src/main/discord/interactions.ts`, `send.ts`, `gifs.ts`, `uploads.ts`).

### 3.3 AI providers
- Interface: reusable (section 2).
- Claude and ChatGPT are plugins that drive the owner's signed-in CLI. `src/core/ai/cliProvider.ts`: "A provider driven through the owner's signed-in CLI (Claude Code, Codex): available while the CLI is on PATH." The bot host would need `claude auth login` and `codex login` done on the server.
- Using a personal Claude or ChatGPT subscription to serve a multi-user bot: [unverified]. `docs/research.md` §2 quotes the Anthropic support article covering "Third-party apps that authenticate with your Claude subscription through the Agent SDK". It says nothing about serving other users.
- Server-friendly alternatives:
  - Ollama (local HTTP).
  - OpenRouter. Its OAuth flow is in main (`src/main/openrouterAuth.ts`); a bot would need a configured key instead.
  - A new Anthropic or OpenAI API-key provider. `docs/research.md` §2: "Raw API keys are out of scope for v1", so this would be a new provider plugin.

### 3.4 Plugins
- Summaries, Alerts, Links and the AI providers live in plugin repos. `docs/plugins.md`: "The app holds no plugins. Every feature plugin (Alerts, Summaries, Tags, Links, the AI providers, the phone transport, …) lives in a plugin repo".
- A bot host needs to provide the core-tier `ctx` (`defineCorePlugin`). Main-tier plugin code ("Discord through the embedded session", `docs/plugins.md` Entries table) and renderer-tier code would not run, or need a bot-backed equivalent.
- Output mapping:
  - `notify(...)` ("A Windows notification", `docs/plugins.md` API table) becomes a bot DM or a channel post.
  - `annotate(...)` and panels become embeds or command replies.
  - Summary citations already resolve to permalinks. `docs/research.md` §2: "opens `https://discord.com/channels/<guild>/<channel>/<message>`". These work in Discord directly.
- Whether the Summaries plugin's core tier depends on main-tier or renderer-tier features: Not found (that repo was not inspected).

### 3.5 Front end: from Settings UI to commands
- Settings live in the `settings` table (`getSetting` / `setSetting` in `src/core/index.ts`). Replace the Solid renderer with application commands, for example: opt a channel in or out, summarize a range, search, add a rule, choose a provider.
- `self` is a single user. `src/core/index.ts`: "The signed-in Discord user (main sends it after sign-in)", used by `matcher().setSelf(user)` and the "Aimed at you" rule. A bot has many requesters, so rules need an owner, and alerts need a recipient.
- Authorization: a check of who may change settings and rules is needed.
- Data leakage: a summary or search answered in channel X must not include text from channels the requester cannot read. Current privacy filtering is per-owner (`src/core/queries/privacy.ts` `visibleMessageSql`), not per-requester. Per-requester filtering would be new work, possibly built on `src/core/access.ts`.

### 3.6 Runtime and policy
- `RuleSchedule` and the `schedule(everyMs, fn)` plugin API run "while the app is open" (`docs/plugins.md`). A bot runs all the time, which reverses the §0 decision.
- Privileged intents need approval once a verified bot reaches 100+ servers. General Discord knowledge, not from this repository: [unverified for current thresholds].
- Keeping deleted and edited messages (`docs/research.md` §1: "deletes set `deleted_at` (soft delete, still viewable)") may conflict with Discord's Developer Policy rules on data handling for bots: [unverified].

## 4. Approaches

1. **Headless fork of core plus a bot ingest layer (most direct reuse).** Run `src/core` in plain Node. Replace `src/main/discord/*`, `src/main/sync/*` and `src/main/media/*` with a Bot-token client that feeds `Archive.ingestMessages` and `applyGatewayEvent`. Add a command layer and the core-tier plugin `ctx`. Most work goes into sections 3.2, 3.5 and 3.6.
2. **Companion bot on the existing desktop app.** Keep user-account ingest. Add a plugin that runs a bot connection and answers commands from the local archive, using the same pattern as the phone transport (`docs/research.md` §0: "Works only while the desktop app runs"). Fewer changes, but it breaks law 4 (a second gateway connection), only works while the PC is on, and exposes data collected by a user account to others, which is a ToS and privacy issue.
3. **New bot that ports only the algorithms.** Write a standard bot (discord.js) and copy the logic: the citation summary format (`docs/research.md` §2: "`[m17] 2026-09-24 14:02 alice: …` with a local ref→snowflake map"), hierarchical chunking, the `LlmProvider` interface, and the rule matcher's cheapest-first tiers. This avoids carrying the desktop, privacy-mode, DM and composer code. Less reuse, simpler result.

## 5. Open items
- Read `Cujuju/ChattyPop-Plugins-Public` to confirm whether Summaries, Alerts and the AI providers depend on main-tier or renderer-tier features.
- Confirm whether a personal Claude or ChatGPT subscription may serve a multi-user bot.
- Confirm Discord's current privileged-intent approval threshold.
- Confirm whether retaining deleted messages fits Discord's Developer Policy for bots.
- Confirm whether `src/core/access.ts` is enough for per-requester channel visibility.
