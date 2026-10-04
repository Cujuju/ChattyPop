# Plugins

Plugins are full trust: plain ES modules loaded into ChattyPop's core process, with full access to the archive and to your AI providers. There is no sandbox. Only install plugins you wrote or trust.

## Install
Settings → Plugins → **Open plugins folder**. Add one folder per plugin, then press **Reload plugins**. Each plugin can be switched off there, and any load error or hook error is shown there too.

## Layout
```
plugins/
  my-plugin/
    plugin.json
    main.mjs
```

`plugin.json`:
| Field | |
|---|---|
| `id` | Lowercase letters, digits and dashes, 2–40 characters. It names the plugin's tables and settings. |
| `version` | The plugin's own version. |
| `apiVersion` | The plugin API it targets (currently `2.0.0`). The plugin loads when the major version matches and its minor isn't newer than the host's. A plugin written for API 1 is refused, and Settings → Plugins says what API 2 changed. |
| `main` | The ES module inside the folder that exports `activate(api)`. |
| `renderer` | Optional (API 1.1): an ES module inside the folder that exports `panels` (see below). |
| `name`, `description` | Optional; shown in Settings. |

`activate(api)` may return a function that runs on unload (reload, switch-off, quit).

## API (v3)
Types: `src/shared/plugins.ts` (`PluginApi`).

**API 3.0** (from 2.x): `ai.complete` takes a required `provider`, the id of a provider in Settings → AI; there is no default provider. `ai.providers()` lists them, each with why it can't run (null when it can). To update a 2.x plugin, set `apiVersion` to `3.0.0` and let the owner pick a provider (a setting), passing it on each request. `ai.complete` and `ai.decide` take a required `reads`, and `query.messages` and `query.channels` return only what privacy mode shows. To update a 1.x plugin, set `apiVersion` to `2.0.0` and give each AI request the channels its text came from.

| Member | |
|---|---|
| `onMessage(fn)` | Every new or edited message text in archived channels: live, catch-up and backfill. Runs after the message is stored; a throw is recorded, never breaks archiving. |
| `schedule(everyMs, fn)` | Repeats while the app is open; at least one minute apart. |
| `commands.register({ id, title, run(range) })` | A button in Settings → Plugins. It runs on the last 24 hours of every archived channel; returned text is shown. |
| `query.messages({ channelIds?, sinceTs?, untilTs?, limit? })` | Archived messages, oldest first (default 1,000, at most 10,000). With privacy mode on, hidden channels' and servers' messages are left out (API 2.0). |
| `query.channels()` | Archived channels with their server names and `localAiOnly`, as privacy mode shows them (API 2.0). A local-AI-only channel's text may go only to a local provider; `reads` enforces it. |
| `db.table(name)` | Namespaced table name `p_<id>_<name>`. Use it for every table. |
| `db.migrate(steps)` | Applies SQL steps not yet applied, each in a transaction. Append steps; never edit a shipped one. |
| `db.prepare(sql)`, `db.transaction(fn)` | Direct SQLite access (better-sqlite3), full trust: raw SQL reads every row whatever privacy mode shows. Once the plugin is turned off, a statement that writes (and `db.migrate`) throws `PluginInactiveError`, even one prepared earlier; reads still work. |
| `settings.get(key)`, `settings.set(key, value)` | JSON values stored under the plugin's id. |
| `ai.complete({ provider, system, prompt, schema?, reads })` | AI provider `provider` with its Settings → AI model; rejects naming why when it can't run or is turned off there. With a JSON schema the result carries `json`. Not counted in the Plan usage panel's ChattyPop totals. `reads` (API 2.0, required): the channel ids the prompt's text came from (a thread by its own id), or `'all'`. When the provider is hosted, a local-AI-only channel (or a thread under one), or `'all'` while any channel is local-AI-only, rejects with `LocalOnlyError` and nothing is sent; no `reads` rejects with `TypeError`. |
| `ai.providers()` | API 3.0: the AI providers in Settings → AI: `{ id, label, local, unavailable }`, `unavailable` saying why one can't run (its plugin off, or turned off there), else null. |
| `ai.decide({ state, questions, reads })` | API 1.2: typed judgments from Jev (yes/no probability, one-of choice, score), no generated text. Needs Settings → Jev → plugins on; throws otherwise. Question shapes: `PluginQuestion` in `src/shared/plugins.ts`. `reads` as for `ai.complete`; Jev is always hosted. |
| `notify({ title, body, channelId?, messageId? })` | A Windows notification; clicking it opens the message. |
| `annotate(messageId, label, text)` | A labelled note under the message in the Archive. The same label replaces it; `null` text removes it. |
| `log(...args)` | Written to the app's console with the plugin id. |
| `rpc.handle(name, fn)` | API 1.1: a function the plugin's panels can call. Arguments and results must be JSON-safe. |

## Panels (API 1.1)
The `renderer` module exports `panels`: `[{ id, title, mount(el, api) }]` (types: `src/renderer/src/plugins/types.ts`). A panel renders into a plain element with its own code; the host shares no framework with it, so bundle whatever you use. `mount` may return a cleanup function.

| `api` member | |
|---|---|
| `call(name, ...args)` | Calls the plugin's `rpc.handle` function in the core. |
| `openMessage(channelId, messageId)` | Opens that message in the Archive. |
| `onArchiveChanged(fn)` | Runs when archived messages change; returns an unsubscribe function. |

To show a panel, right-click any panel header → **Add <title> below**; the layout becomes a custom layout. Right-click the plugin panel's header → **Remove … from this layout**. Panels run in the app window with full trust, like the rest of a plugin.

## Reloading
**Reload plugins** re-imports each plugin's `main` file. Modules that `main` imports are cached until the app restarts.

## Example
`docs/plugins/example-activity/`: counts messages per author in its own table, notes questions, has a "Top posters" command, and an Activity panel.

## Descriptor plugins
Architecture spec (extension points, SDK, channels, placement): `docs/plugin-architecture.md`.

The app holds no plugins. Every feature plugin (Alerts, Summaries, Tags, Links, the AI providers, the phone transport, …) lives in a plugin repo, one folder per plugin under `plugins/<id>/`; `Cujuju/ChattyPop-Plugins-Public` is built in as a marketplace. A build that ships has none; they are installed from Settings → Plugins → Marketplaces (`docs/plugin-architecture.md` §16), and they show there with the same on/off switch and error reporting as folder plugins.

**Developing plugins from their repos.** `CHATTYPOP_PLUGIN_DIRS` names the folders of plugin folders `pnpm dev` compiles in: absolute paths to local clones' `plugins` folders, joined by `;` on Windows (`:` elsewhere), e.g. `C:\code\ChattyPop-Plugins-Public\plugins;C:\code\my-plugins\plugins`. They run with hot reload in windows. Unset, the app runs with none. A plugin's own packages (its `package.json` `dependencies`) must be installed in its folder (`npm ci --ignore-scripts`, so no dependency runs a script); `solid-js` and the SDK come from the host. An id in two folders fails the build. A plugin run this way is bundled, so an installed copy with the same id is refused for that run. Only `pnpm dev` reads the variable: a build (`build`, `dist`, `package`, `preview`) and `pnpm test` have no plugins, whatever it holds.

**Choosing plugins.** `CHATTYPOP_PLUGINS` chooses among those folders: unset = all, `none` = none (empty also works where the shell can set an empty variable), `a,b` = those (an unknown id fails the build). `bundledPlugins.ts` (Vite plugin) turns the choice into `virtual:bundled-plugins/{shared,core,main,renderer}`; a left-out plugin's code is not in the build.

**Checking and releasing.** From this checkout, `pnpm plugin:check <pluginDir>` type-checks, style-checks, builds and tests a plugin folder against the host, and `pnpm plugin:release-changed <pluginsRepoDir> --repo <owner/name>` stamps and publishes every changed plugin in a plugin repo, which its CI runs on each push to `main` (`docs/plugin-architecture.md` §16).

**Boundary.** The app holds no plugin code; it reaches plugins only through those registries and the installed-plugin loaders. Plugins import only the Plugin SDK (`@plugin-sdk/{shared,core,main,renderer}`), their own folder and packages; the installed build refuses host internals, and `pnpm plugin:check` scans a plugin's source for these and the other source rules (plugin-architecture.md §16). No renderer SDK tier loads the plugin registry or a plugin, however indirectly (`tests/rendererBoundary.test.ts`), so the SDK initialises before any plugin (`tests/rendererInit.test.ts`). This descriptor SDK is first-party, built with the app; folder plugins' `PluginApi` is the versioned public contract.

**Entries** (each optional except `shared`). The design, extension points and services are in [plugin-architecture.md](plugin-architecture.md).
| File | Default export | |
|---|---|---|
| `shared/index.ts` | `definePlugin({...})` | `manifest` (id = folder name), `channels` (`defineChannels`: core and main calls and core events, each with its audiences), `panels`, `settings` (a tab or a section of Settings → AI / Archive), `ruleActions` (`defineRuleAction`: type `<id>.<name>`), `shortcuts` (single keys, pressed after the leader key, and their status-bar hints), `jev` (queries and switches, stored as `<id>.<key>`), `notices` (its notice kinds, `<id>.<kind>`), `network` (HTTPS hosts its core may reach), `adopts` (host data it takes over). |
| `core/index.ts` | `defineCorePlugin(plugin, activate)` | `activate(ctx)`: storage, its settings, archive hooks (text, attachments, changes, link index rebuilds) and derived text, messages as the Archive shows them, attachment notes, identity, rule actions and runs, AI and its settings, Jev questions and switches, `net.fetch`, `channels.serve` / `emit`. |
| `main/index.ts` | `defineMainPlugin(plugin, activate)` | `activate(ctx)`: Discord through the embedded session (writes only with descriptor `discord: { write: true }`), emojis, dialogs, `attachments.fetchTo`, `sync`, `channels.core` / `serve` / `on`. |
| `renderer/index.tsx` | `defineRendererPlugin(plugin, contributions)` | Views for its declared panels, settings pages and rule actions, and actions for its shortcuts (required by type), and rule templates, acts-as-you notes, composer commands and a message-menu group. Shown only while the plugin is on. |

**Calls between processes.** One contract per plugin (`channels`). The renderer uses `coreClient(plugin)` (or `desktopCoreClient`/`phoneCoreClient` for code one window runs), `mainClient(plugin)`, `pluginResource`, `onEvent` and `callable`; main uses `ctx.channels.core` and `on`. The transport stamps each call's origin (window, phone, main) and core answers only the audiences the contract declares; main hands each event to exactly its audiences.

**Network.** A plugin reaches the network only through `ctx.net.fetch`: HTTPS to a host its descriptor lists or a subdomain of one, each redirect hop checked before it is sent. Discord's domains can't be listed (law 4). The boundary test refuses a plugin that uses the global `fetch`, `window.chattypop` or Node's network modules.

**Rule actions.** A rule stores a plugin's action as `{ kind: 'pluginAction', type, config }`; its runs are recorded under `type`. Without the plugin (left out or off) the rule stays saved and the action is skipped with a reason; an unknown type counts as acting as you, so it still needs the rule's Discord-post opt-in.

**Data from before the conversion.** Renames are declared in each plugin's descriptor (`adopts`) and run at startup for every plugin loaded, on or off, so a profile's data is adopted whenever its plugin is installed: `plans` → `p_plans_items`, `transcripts` → `p_transcription_jobs`, `link_judgments` → `p_links_judgments`, `x_posts` → `p_links_x_posts`; settings `transcription` → `plugin.transcription.settings`, `plans.seen` → `plugin.plans.seen`, `links.seenUpTo` → `plugin.links.seenUpTo`, `stats.scope`/`stats.range` → `plugin.stats.*`; main moves `<profile>/transcription` to `<profile>/plugin-data/transcription`. Data fixes stay with the plugin or host: done transcripts move to the host's `derived_texts` (a host migration).

