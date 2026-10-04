# ChattyPop — Research

Discord archive + AI summarizer + topic alerts + media-link feed, with a plugin architecture.
Researched 2026-09-24. Versions are from npm, nodejs.org and releases.electronjs.org on that date.

## 0. Decisions (from owner)
| Area | Decision |
|---|---|
| Discord access | **User account (not bot)**. Ban risk accepted. Keep request volume modest. |
| AI | Claude and ChatGPT via their **CLIs / subscription** (like T3 Code). Local AI also supported. |
| Stack | Latest Electron (and the Node it bundles). **SolidJS 1.9** (latest stable). |
| Attachments | Download and archive. |
| Retention | User-set history depth and disk cap. Evict older content for newer. Compress history but keep summaries. |
| Rules | Created in the UI; topics merged into them: an Alert action lists matches in Alerts with an optional toast. Edited in Settings → Rules (the Rules panel is retired), where the built-in rules' switches live too. No background running: closed means closed. |
| Summaries | Link back to source messages. |
| Plugins | **Full trust** (the plugin author is the user). |
| Right pane | **Embedded live Discord web client.** |
| Layout | User picks in app: side-by-side, stacked, or tabbed. |
| Channel scope | **Opt-in per channel.** |
| Direct messages | The signed-in account's DMs and groups are listed from the live client's gateway, at no extra requests. Archiving stays **opt-in per DM**; an optional setting (**off by default**) archives a DM when it gets a message after the setting was turned on, skipping requests and DMs the owner declined. Starting a DM or group, adding friends, renaming, muting, marking read, closing and leaving happen in the app, each in the live client's own request shape. Removing people and group icons stay in the live client (`docs/dms.md`). |
| Providers | Claude (Agent SDK → Claude Code), ChatGPT (Codex app-server), **Ollama**, **OpenRouter**. |
| Alerts | In-app inbox + Windows notifications. |
| Attachments retention | Kept at full fidelity. Eviction is a **separate, independent** option; text compression never touches attachments. |
| X links | Posts Discord never previewed are fetched from **FxTwitter** (`api.fxtwitter.com`, unofficial), on view in the Links views, and cached. Images load from `pbs.twimg.com` in a cookie-less session. |
| Transcription | Voice messages → text **locally** (whisper.cpp + ffmpeg); audio never leaves the machine. New voice messages automatically, older ones on request. Transcripts outlive pruned audio and feed search, rules and summaries. Programs and models download on request from pinned GitHub / Hugging Face URLs, SHA-256 verified, into the app profile (`plugin-data/transcription`). Each model shows measured accuracy and speed (method: the `transcription` plugin's `core/catalog.ts`); Turbo (quantized) is the recommended pick. With FxTwitter and Klipy, the only third-party fetches besides AI providers. |
| Archive composer | The Archive has Discord's message bar: post, reply, attach files, and GIF / sticker / emoji pickers. GIF search goes through Discord's own `/gifs/*` endpoints (Klipy behind them, as in the live client); result previews load from **Klipy** (`static.klipy.com`) in the cookie-less session, on picker open only, not stored. Server emoji and stickers come from the gateway; Unicode emoji from emojibase-data; Lottie stickers draw with lottie-web (light build, no expressions). Items the plan can't send (Nitro) show disabled. |
| Slash commands | The composer's `/` menu lists the channel's app commands (Discord's `application-command-index` for the server or DM, plus the owner's installed apps) and plugins' composer commands, grouped by app with a Frequently Used group counted from apps' archived replies. Commands, autocomplete, bot buttons and menus, and bot forms post to `/interactions` as the client does (its gateway `session_id`); results are matched by nonce on the tapped gateway. Ephemeral replies are archived with an "Only you can see this" mark and never counted as deleted by re-sync. Not built: user/message context-menu commands, Discord's client-side built-ins (/shrug, /me), and permission filtering (Discord rejects commands the owner can't use). User pickers search people the archive knows. |
| Phone companion | A phone's browser reads the Archive and plugins' phone sections through a phone transport plugin: an HTTP server in main (at most one per build; `docs/plugin-architecture.md` §3, phone transport). **Off by default.** It listens on loopback only; **Tailscale Serve** publishes it with a publicly trusted certificate (`ctx.net.tailnet`; Tailscale needed on the PC and the phone). Pairing and device credentials are the transport's. Only the calls in `PHONE_*_METHODS` and events in `PHONE_EVENT_TYPES` (and plugin members whose audiences include `phone`) cross; settings, keys, rules and plugins stay desktop-only. Works only while the desktop app runs. Capacitor packaging: `docs/ios-shell.md`. |

## 1. Discord ingestion (user account)

### ToS context (for the record)
Community Guidelines #14 bans self-bots. The ToS bans scraping via "any robot, spider, crawler, scraper, or other automatic device, process, or software". Developer Policy #4/#20 ban token collection and scraping for *apps*. DiscordChatExporter (DCE) supports user tokens with the warning "automating user accounts is against Discord TOS and may result in you getting banned." Accepted by owner.

### Getting the token (no pasting, no devtools)
1. Right pane hosts the real Discord web client in a `WebContentsView` with `session.fromPartition('persist:discord')`. The user logs in there; a human handles 2FA and captcha.
2. `ses.webRequest.onBeforeSendHeaders({ urls: ['https://discord.com/api/*'] })` reads the `Authorization` header from the client's own requests. It also copies `X-Super-Properties` verbatim, which keeps `client_build_number` current. Store both with `safeStorage` (DPAPI on Windows).
3. Recapture automatically on any 401.

### Making REST requests look like the client
- Send requests with **`ses.fetch()` on the Discord session**, not Node `fetch`/undici. This uses Chromium's network stack, so the TLS fingerprint, cookies (`__dcfduid`, `cf_clearance`…) and User-Agent are identical to the embedded client. Node's undici has a distinct TLS fingerprint. *Spike: confirm `ses.fetch` from main and how to use it from a utilityProcess (proxy over MessagePort if needed).*
- Headers: `Authorization`, `X-Super-Properties` (captured), `X-Discord-Locale`, `X-Discord-Timezone`. API **v9** (the web client's version, per [discord.food](https://docs.discord.food/reference)); DCE uses v10.
- Pacing: honor `X-RateLimit-Remaining`/`Reset-After` and 429 `Retry-After` (DCE logic, §5). On top of that, add a configurable client-side budget: requests/min and max messages per session, with jitter. Assumption: the web client fetches pages of `limit=50` while scrolling. Measure it in the spike via CDP and copy it, rather than using DCE's 100.
- History algorithm (from DCE `DiscordClient.cs`): `GET channels/{id}/messages?limit=N&after=<snowflake>` loop. Batches arrive newest-first. Fetch the terminal message first to bound the range, because `before`+`after` can't be combined. User accounts enumerate threads via `channels/{id}/threads/search`; single messages via `messages?around=<id>&limit=1`.
- DMs and group DMs are now reachable (`users/@me/channels`).

### Real-time
| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Passive tap (recommended)** | `webContents.debugger.attach()` → CDP `Network.enable` → `Network.webSocketFrameReceived` on the embedded client's gateway socket. Decompress with a persistent `zstd-stream`/`zlib-stream` context (`node:zlib` has both). Parse MESSAGE_CREATE/UPDATE/DELETE. | **Zero extra requests or sessions.** Indistinguishable from normal use. | Works only while the embedded client is open. Must attach before the socket opens (attach, then reload). Breaks if Discord changes transport or encoding. |
| B. Own gateway connection | IDENTIFY with the token | Works without the embedded client | A second session and device fingerprint to Discord. More detectable. |

Either way: guilds with ≥75,000 members aren't auto-subscribed, so no MESSAGE_CREATE from them without op 37 (per unofficial [discord.py-self docs](https://discordpy-self.readthedocs.io/en/latest/guild_subscriptions.html)). With option A the client only subscribes to what the user opens. On app start, backfill each followed channel with `after=<last stored id>`. This gives one code path for batch and catch-up.

### Edits and deletes
- The gateway sends MESSAGE_UPDATE / MESSAGE_DELETE for **any** message, whatever its age, to connected clients subscribed to that guild. Assumption from gateway semantics; verify in spike 3. So with the passive tap, a three-day-old edit is seen **if the app is open** at the time.
- Changes made while the app is closed are invisible until a re-poll. Optional per-channel "re-verify last N days" job on startup: re-fetch the window and diff by `edited_timestamp`. Deletions show up as IDs missing from a contiguous fetched range. This costs extra requests, so it is off by default.
- Proposed storage: edits append to `message_revisions` (the old content is kept); deletes set `deleted_at` (soft delete, still viewable, marked in UI). Owner undecided. This default keeps the most information and is reversible.

### Attachments
CDN URLs are signed (`ex`, `is`, `hm`) and expire ([API reference](https://docs.discord.com/developers/reference)). Download at ingest into a content-addressed store (`sha256`). Media-proxy thumbnails of external embeds are a separate question. *Assumption: they don't expire. Verify.*

## 2. AI providers

### How T3 Code does "use your subscription" (read from source, pingdotgg/t3code @59abcd67, MIT)
- **Claude**: `@anthropic-ai/claude-agent-sdk` `query()` with `pathToClaudeCodeExecutable` → the user's installed Claude Code. Auth is whatever `claude auth login` set; the app never touches credentials. Windows gotcha: the SDK spawns without a shell, so a bare `claude` or npm `claude.cmd` shim fails (`spawn EINVAL`). Resolve PATH/PATHEXT and follow the shim to `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (`ClaudeExecutable.ts`).
- **Codex**: spawns `codex app-server` and speaks JSON-RPC over stdio (`initialize`, `thread/start`, turns…). Auth comes from `codex login` (ChatGPT plan). OpenAI also ships `@openai/codex-sdk` (0.156.1, Apache-2.0) over the same app-server.
- **Plan usage meters**: Claude via the SDK `get_usage` control request plus streamed `rate_limit_event` (`five_hour`, `seven_day` windows). Codex via `account/rateLimits/read` plus `account/rateLimits/updated` (`primary`/`secondary` windows). Files: `claudeUsageLimits.ts`, `codexUsageLimits.ts`.

### Is it allowed?
- **Claude: yes, as of 2026-05-13.** [Support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (updated 2026-06-16) lists the Agent SDK, `claude -p`, and "Third-party apps that authenticate with your Claude subscription through the Agent SDK" as eligible, drawing from normal plan limits. The separate "Agent SDK credit" planned for 2026-06-15 was **paused**; Anthropic says it will give advance notice before changing anything. Keep sign-in inside Anthropic's own flow (`claude auth login`); never read or store Claude credentials ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- **ChatGPT: via Codex only.** ChatGPT OAuth tokens are rejected by `api.openai.com`. Codex CLI/app-server/SDK with ChatGPT sign-in is the supported route ("build Codex into your own internal tools and workflows", [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)).

### Using coding agents as plain summarizers
- Claude Agent SDK 0.3.282 options (from `sdk.d.ts`): `tools: []` (no tools), `settingSources: []` (ignore user CLAUDE.md, skills and hooks), `maxTurns: 1`, `persistSession: false`, custom `systemPrompt`, `model`, and **`outputFormat`** (JSON schema, for structured summaries with citations).
- Codex app-server: start an ephemeral thread with a read-only sandbox and approval policy `never`. *Spike: exact params, and whether tool use can be fully disabled.*
- Cost of this route: process spawn per session (keep one warm), agent system-prompt overhead per call, and plan rate limits shared with the user's own coding use. Show the usage meters in the UI for this reason.

### Other providers (same interface)
**Ollama** (OpenAI-compatible `/v1` at `localhost:11434`; the `ollama` npm package 0.6.3 is optional) and **OpenRouter** (OAuth PKCE → user key, [docs](https://openrouter.ai/docs/use-cases/oauth-pkce)). Raw API keys are out of scope for v1. Interface sketch: `complete({ system, messages, schema? }) → { text | json, usage }` plus optional `planUsage()`.

### Summaries with citations
Send messages as `[m17] 2026-09-24 14:02 alice: …` with a local ref→snowflake map. Require schema output `{ items: [{ text, refs: ["m17", …] }] }`. The UI maps refs back to message IDs: click scrolls the chat pane (archive view) or opens `https://discord.com/channels/<guild>/<channel>/<message>`. Summarize long ranges hierarchically (chunk → summarize → merge). Cache by (channel, first id, last id, provider/model, prompt version) so reruns are incremental.

### Rules and alerts
Topics became rules. A rule: WHEN (a message, a tag put on one, or a time: daily at a time, every N hours, or on opening after N hours away) → gates (where, who, edits, missed messages, Discord-post opt-in) → IF any match (keywords, meaning via Jev, own Jev question; none = narrowing decides) narrowed by contents/links/tags → THEN actions (Alert, tag, summarize, file, plugin, Discord post). Alert rules keep archive-wide history (read) of direct matches. Built-in rules "Aimed at you" and "Open questions" follow their Jev switches. A timed rule has no match step and only summarizes or runs a plugin over its window (since its last run, at most a week) in its Where; the old catch-up and daily digest settings became the ordinary rules "Catch me up" and "Daily digest". Original design, kept for reference:

Topics are UI-created: name, keywords/regex, optional natural-language description, channel scope, cooldown. Matching runs cheapest-first: (1) keyword/regex on every message; (2) optional embedding similarity (local embedder + `sqlite-vec` 0.1.9) against the description; (3) optional LLM confirm on tier-2 hits only. Delivery is TBD. Cheapest default: an in-app alert inbox plus Electron `Notification` (Windows toast; needs AppUserModelID). Other channels can be plugins.

## 3. Stack (verified 2026-09-24)
| Item | Version | Note |
|---|---|---|
| Electron | **44.4.5** | Chromium 152, **Node 24.21.0** bundled. This is the app's Node. |
| Node (tooling) | 26.10.0 current / 24.21.0 LTS | Use 24 LTS for tooling to match Electron's runtime. |
| solid-js | **1.9.15** | 2.0 is RC (rc.9). Ecosystem still pins ^1.x. |
| @solidjs/router | 1.0.0 | Peer `solid-js ^1.8.6`. |
| @cujuju/solidjs-virtual-log | link (toolkit) | Virtualized chat and the Links panel: bottom-anchored, never writes the scroll offset mid-gesture (iOS momentum). Replaced @tanstack/solid-virtual. |
| vite / electron-vite | **7.3.6 / 5.0.0** | electron-vite 5 supports vite ≤7. Vite 8 needs electron-vite 6 **beta**. |
| vite-plugin-solid | 2.11.14 | |
| TypeScript | 7.0.2 | Native compiler. Type-check only; Vite transpiles. *Spike: toolchain compatibility.* |
| electron-builder | 26.15.3 | Personal use: unsigned NSIS/portable is fine. |
| @anthropic-ai/claude-agent-sdk | 0.3.282 | The `claude` plugin's package (Plugins-Public), not the app's since plugins left the app. |
| @cujuju/solidjs-* | per package | The solidjs-toolkit packages (seg-buttons, select-flyout, context-menu, accordion-dock, hooks…). Themed via CSS variables; bridged to `--cp-*` tokens. |
| Styling | plain CSS | Tokens (`--cp-*`) + CSS Modules per panel. No Tailwind (see §10). The design agent owns `src/renderer/src/theme/**` and `*.module.css` (CLAUDE.md law 3). |
| @openai/codex-sdk | 0.156.1 | Optional; can speak JSON-RPC to `codex app-server` directly. |
| @discordjs/rest | (bot-oriented) | **Not a fit for user tokens** (bot auth scheme, v10, undici). Write a small client on `ses.fetch` modeled on DCE. |

## 4. Storage and retention
- **SQLite via `better-sqlite3-multiple-ciphers` 13.0.3** (owner decision: encryption-ready, unencrypted at first). It's Node-API (`NAPI_VERSION=10`) with **prebuilt `win32-x64.node` inside the npm tarball**, so there's no `@electron/rebuild` and no C++ toolchain. Package it with `asarUnpack` for the `.node` file. Later encryption: `PRAGMA key`, with the key held in `safeStorage`. `node:sqlite` was dropped.
- Tables: `guilds`, `channels`, `users`, `messages(id snowflake PK, channel_id, author_id, ts, edited_ts, content, raw_zst)`, `attachments(sha256, bytes, mime, path, message_id)`, `links`, `summaries`, `summary_refs`, `rules`, `rule_runs`, `alerts`, `fts_messages` (FTS5), `plugin_*` (namespaced per plugin). Snowflake → ms: `(id >> 22) + 1420070400000`.
- **Text retention** (per channel or global; attachments unaffected):
  1. *Full*: rows plus raw JSON.
  2. *Compressed*: raw JSON zstd-compressed with `node:zlib` (experimental in Node 24; `dictionary` option since 24.20; no dictionary *training* API). Normalized columns and FTS remain.
  3. *Summary-only*: message rows deleted; **summaries and tombstones** (id, channel, author, ts) kept so citations still resolve to Discord permalinks.
  Invariant: a range can only become Summary-only after a summary covers it.
- **Attachment retention** (separate option): keep all at full fidelity (default), or evict oldest-first under a cap. Never re-encoded. An evicted attachment keeps its metadata row and a Discord permalink.
- Disk cap = DB size (`page_count × page_size`) + attachment store. Create the DB with `auto_vacuum=INCREMENTAL` (it can't be switched on later without a full VACUUM) and reclaim with `incremental_vacuum`. Eviction runs oldest-first per channel; pinned/starred messages are exempt.

## 5. DCE reference notes (Tyrrrz/DiscordChatExporter @3a8ef99, 2026-09-01, MIT)
- **Scope: batch export only.** No gateway/WebSocket code, so no real-time, and no embedded browser. The user **pastes a token** obtained manually via browser devtools (console webpack snippet, Network tab `Authorization` header, or Storage inspector). The GUI persists it encrypted (`SettingsService.LastToken`, `TokenEncryptionConverter`, opt-out `IsTokenPersisted`).
- Requests go from .NET `HttpClient` to API v10 with only an `Authorization` header: no `X-Super-Properties` and a non-browser TLS fingerprint. ChattyPop's `ses.fetch` approach is stealthier than this baseline.
- Rate limits: sleeps `Reset-After`+1s (cap 60s) when `Remaining` reaches 0. Retries 429/5xx up to 8×, using `Retry-After`+1s or backoff 2ⁿ+1s.
- An all-empty `content` batch means missing MESSAGE_CONTENT (bots only).
- Filter DSL (`from:`, `has:`, `mentions:`, `reaction:`, boolean ops). Its JSON export schema is a candidate **import plugin** for existing exports.

## 6. Architecture
- **Processes**: main (windows, token capture, `ses.fetch` Discord client, secrets) · utilityProcess "core" (SQLite writer, ingest queue, plugin host, AI calls, CLI child processes) · renderer (Solid; `contextIsolation`, `sandbox`, typed preload bridge) · `WebContentsView` (Discord web client, `persist:discord`).
- **UI v1**: two main panels, topics/alerts/summaries (with citation chips) and the live Discord client. Layout is user-selectable: side-by-side, stacked or tabbed; the choice persists. The Discord pane is a native `WebContentsView` overlaid on the window, not DOM. The renderer must report the panel's bounds (ResizeObserver → IPC → `view.setBounds`) and hide the view when its tab is inactive. Citation clicks open the message via the in-app client's route `https://discord.com/channels/<g>/<c>/<m>`. Links live in the **Links** panel: every shared link, virtualized and paged, filterable by platform, channel and date, with a "seen up to" watermark (advanced while the panel is on screen) for catch-up.
- **Media links**: URLs from `content` (linkifyjs 4.3.3; respect `<url>` suppression) plus `embeds[]` (`url`, `type`, `provider.name`, thumbnail; Discord has already unfurled them). Classify by domain (YouTube, X/Twitter + fx/vx mirrors, Instagram, TikTok, Reddit, Bluesky, Threads, Twitch…). Dedupe by URL with first-seen message.

## 7. Plugins (full trust)
- Loaded as ESM into the core utilityProcess. No sandbox or permission system. A **versioned API** (`apiVersion` semver in the manifest) is still the contract, so plugins don't break on refactors.
- Manifest: `id`, `version`, `apiVersion`, `main` (core entry), optional `renderer` (UI entry), `contributes` (views, commands, settings schema).
- Core API: read queries (channel/time/FTS), own namespaced tables with migrations, `onMessage`, `onBackfill(range)`, `runOnDemand(range)`, scheduler (while the app is open), `ai.complete()` (user's chosen provider), `notify()`, `annotate()` (summary, alert, link, tag rendered by the host UI).
- Renderer entry: loaded via a custom protocol (`chattypop-plugin://`). It must use the host's `solid-js` instance (import map / externals). Two Solid copies break reactivity.
- Core built-ins (summarizer, rule matcher, media-links) stay native: owner decision. Revised for distribution: features became **descriptor plugins**, and the app now holds none: every plugin lives in a plugin repo (the built-in marketplace is `Cujuju/ChattyPop-Plugins-Public`) and is installed from a marketplace (development: `CHATTYPOP_PLUGIN_DIRS`). See docs/plugins.md → Descriptor plugins.

### 7.1 Extraction roadmap
Survey of the remaining features (2026-09). What blocks extraction is the host's closed lists and hard-coded registries (`TRIGGER_OPTIONS`, `openMessageMenu`, `PROVIDER_IDS`, Settings and phone `TABS`, `register*` calls in `core/index.ts`); each addition below turns one into a registry.

**Stays in the host**: archive, ingest, sync, backfill; the Discord client (capture, gateway, `DiscordApi`, composer, bot modal); the rules engine; the Jev decision service; privacy mode; database, migrations, encryption, archive move, retention; layout; core search.

**Candidates**: Plans & decisions (small), Transcription, Media links + link judge + X posts, Tags, Alerts, Summaries, AI providers + Plan usage, Phone companion. Estimate: about 60–65% of feature code.

**Host additions**
| # | Where | Addition | Replaces |
|---|---|---|---|
| 1 | core | Plugin services and dependencies: manifest `provides`/`requires`, `host.services`, activation in dependency order | creation order in `core/index.ts`; plugins' direct `transcripts.due` |
| 2 | core | Derived text: a plugin publishes text for a message; the host re-runs rules, dispatches to plugins, indexes it | transcription's `onSettled` wiring |
| 3 | core | Rule extension points: trigger kinds (`host.rules.fire`), match and filter kinds (predicate, optional Jev question), actions that run at match time | fixed `RuleTrigger`/`RuleMatch`; Alert recorded by the engine |
| 4 | core | Jev registry (done): `host.jev.registerMessageQuestion`, asked after the host's questions and before the owner's custom tags, in build order; plugin Jev queries and Settings → Jev switches | `registerPlans` in core init |
| 5 | core | Privacy-safe reads: message reads through a host query layer; a boundary test enforces it | `visibleMessageSql` by convention |
| 6 | core | Plugin events to the plugin's renderer and the phone (`plugin-event`) | one AppEvent type per feature |
| 7 | core | Lifecycle: `onArchiveReady`/`onArchiveClosing`, timers that pause while the archive is closed | features catching `ready()` throws |
| 8 | core | Settings change hooks: `host.settings.onChange(key)` (done: a plugin's own settings, and `ctx.ai.onSettingsChange`) | host reacting to an `'ai'` save for others |
| 9 | core | AI provider registry (done): descriptor `providers`, `ctx.ai.registerProvider(id, { create, status })`; never Claude/ChatGPT credentials (law 5) | `PROVIDER_IDS` |
| 10 | shared | Search: filter-token and rerank registry shared by the core parser and the renderer | closed `NAME_KEYS`/`HAS_KINDS`/`IS_KINDS`; `searchRerank` |
| 11 | main | Desktop notifications and tray badge (`host.notify`) | `main/alertNotifier.ts` wired in `coreEvents` |
| 12 | main | Live Discord view decoration (CSS and DOM injection) | `LiveTags`, beside privacy CSS |
| 13 | main | Per-plugin data folder, downloads, DPAPI secrets, outbound-network policy; Discord only through `DiscordApi` (law 4) (done: data folder; network policy as core `ctx.net.fetch`, declared hosts) | toolchain downloads, OpenRouter key files, `xPosts` fetch |
| 14 | main | Phone: route registration, event stream, push | `CompanionServer` built-ins |
| 15 | renderer | Settings pages and sections on every page; message-row decorations, message menu items, hover actions | `SettingsDialog` `TABS`, `SettingsPageId` = ai/archive, `state/messageActions.ts` |
| 16 | renderer | Top-bar buttons, status-bar items, keyboard shortcuts (done: single-key shortcuts with their hints) | `TopBar`, status bar items, `state/shortcuts.ts` |
| 17 | renderer | Rule editors for trigger/match/filter kinds; phone tabs and drawer items; navigation API (open a message, citations) | `GatesStep`/`MatchStep` branches, `CompanionApp` `TABS` |

**Waves** (each wave builds only what its conversions use; each conversion gets a parity audit like the first four)
| Wave | Additions | Conversions |
|---|---|---|
| 1 (done) | 4 | Plans & decisions |
| 2 | 2, 6, 8 (key hooks), 13 (data folder), 15 (settings tabs, attachment notes, message menu), phone calls and events | Transcription |
| 3 | 1, 3, 5, 7, 8, 10, 11, 12, 13 (outbound fetch), 16, 17 (rule editors) | Media links + X posts, Tags, Alerts, Summaries |
| 4 (done; 13 secrets deferred) | 9 | AI providers, Plan usage |
| 5 | 14, 17 (phone) | Phone companion |

**Wave 2 design (Transcription)**
- Derived text: the host owns `derived_texts` (message, source key, order, text) and its FTS index; message text, content, search and Jev read it. A plugin calls `host.text.settle(messageId, text | null)`: text is stored and dispatched as an edit (rules, Jev, plugins' `onText` with source `transcript`), then every plugin's `host.text.onSettled` runs. `host.text.registerPending(fn)` says text is still coming; a plugin that needs a message's transcript waits on `host.text.pending`, so it needs no service (addition 1 moves to wave 3).
- Attachment notes: a core plugin annotates attachments (`host.archive.attachmentNotes`); the host draws each note under its attachment and emits `attachment-notes-changed`, so the Archive and the phone re-read those rows.
- Plugin events: `host.events.emit(name, payload)` → `plugin-event`; the renderer subscribes with `onPluginEvent`.
- Phone: a plugin's shared entry lists the core calls and events the phone may use (`phone.calls`, `phone.events`); the phone transport enforces the list.
- `host.settings.onChange(key)`, `host.onAttachmentStored`, `host.dataDir` (`<profile>/plugin-data/<id>`; main moves the old `<profile>/transcription` once), main's `host.attachments.fetchTo` (audio through the Discord session, law 4).
- Renderer: plugin Settings tabs (`after` anchors order), message menu groups (after Copy).
- `transcripts` becomes the plugin's `p_transcription_jobs` (queue and results); done texts are copied into `derived_texts` keeping their order.

Risks: every conversion needs a parity audit (the first four had 9 real differences); CSS Modules inside plugin folders need a ruling on design-agent ownership (law 3); more plugin combinations to build and test; Summaries and the phone cost most for least payoff, since nearly every build keeps them.

## 8. Open questions
Resolved: edits and deletes are kept (revisions + soft delete), and the **original is shown next to the edit or delete**. An offline **Archive view** (ChattyPop's own message renderer) sits beside the live client via a Live | Archive switch.
1. **Real-time**: passive tap (A) is implied by the embedded-client decision. Confirm there is no standalone gateway (B).
2. UI direction: **F2 "Night Console" (stacked)** chosen from 6 mockups. It is a starting point, not a final design: see §10.

## 10. UI built to be redesigned
Principle: a redesign (layout, look, or both) should touch only the view layer: no data, IPC or store changes.

| Layer | Owns | Redesign touches it? |
|---|---|---|
| **Stores** (`src/state/*`) | Typed Solid stores/resources over the preload bridge: channels, summaries, alerts, links, sync, provider usage | No |
| **Panels** (`src/panels/<id>/`) | One self-contained component per named section. Reads stores only, never IPC. Has no outer margins or fixed size: it fills whatever slot it's given. | Only if that panel's look changes |
| **Layout** (`src/layout/`) | A layout tree as data: `split` (dir, sizes) / `tabs` / `panel(id)`. Presets `side-by-side`, `stacked`, `tabbed` plus user-saved layouts. Renderer walks the tree. | Yes, and it's the only place |
| **Theme** (`src/theme/`) | Design tokens as CSS custom properties: color, type scale, spacing, radius, elevation, motion. One file per theme (F2 dark first). | Yes, for a visual redesign |
| **Primitives** (`src/ui/`) | Button, Chip, Meter, Tabs, List row, Icon. Styled only from tokens. | Rarely |

- **Panel registry**: `id → { title, icon, component, minSize }`. Panel IDs from F2: `channels`, `sync-status`, `summary`, `provider`, `alerts`, `links`, `chat`, `status-bar`. Retired: `topics` and `rules` (now Settings → Rules); saved layouts drop them. The top bar is the app frame, not a panel. Plugins register panels through the same registry.
- **Layout persistence**: the layout tree is JSON in settings, versioned. Unknown panel IDs (a removed plugin) render a "missing panel" placeholder instead of breaking the layout.
- **Rules that keep redesigns cheap**:
  - No color, size or font literal outside `src/theme/`; lint for hex/px in components.
  - CSS Modules per panel (Vite built-in, no dependency). Panels never style each other.
  - Panels talk to each other only through stores or app commands (e.g. `openCitation(messageId)`), never by importing one another.
  - Icons go through one `Icon` component, so the icon set can be swapped.
- **Live Discord pane**: the `chat` panel reports its slot bounds (ResizeObserver → IPC → `WebContentsView.setBounds`) and visibility, so it follows any layout.
- **Later**: drag-and-drop docking on the same layout tree (a library would be a new dependency; ask first).

## 11. Spikes (before building)
1. `better-sqlite3-multiple-ciphers` + FTS5 loads in an Electron 44 utilityProcess (and packaged, `asarUnpack`).
2. Token capture + `ses.fetch` history page from the embedded client. Measure the real client's page size and request cadence via CDP.
3. CDP gateway tap: attach, decompress zstd-stream, parse MESSAGE_CREATE.
4. Claude Agent SDK one-shot with `tools: []`, `outputFormat` schema, `get_usage`. Codex app-server one-shot with read-only sandbox and `account/rateLimits/read`.
5. Scaffold: electron-vite 5 + Vite 7 + Solid 1.9 + TS 7 type-check.
6. Layout tree renders all three presets. The `WebContentsView` tracks the `chat` slot through resize, layout switch and tab hide.
