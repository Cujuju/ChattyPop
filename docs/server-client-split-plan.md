# Server/client split: implementation plan

Tracking issue: #132. Branch: `server-client-split` (host) and `server-client-split` (Plugins-Private, companion).
Base: `origin/main` at `a9cdb21`. Scope: macOS and Windows servers and clients first; Linux last (used here only as a
headless test harness under Xvfb).

## 0. Already on main (not in this plan)
The macOS work under #132 has landed: packaging (dmg + update zip), macOS CI and release builds, tray and menus,
login item, Tailscale lookup on macOS (`171c942`), POSIX tool folders. This plan builds on it.

## 1. Decisions this plan assumes (owner may change them)
| # | Decision | Default used here |
|---|---|---|
| D1 | Live Discord pane on a remote desktop | **Archive only** (option c). The server's live client is reachable from a client only through the sign-in relay (phase 5). |
| D2 | §0 "No background running: closed means closed" | **Amended for server mode only**: a `--server` run keeps running hidden until Quit. Normal runs unchanged. |
| D3 | Device auth | **Reuse the companion's pairing** (one-time code, `cp_companion` cookie) over Tailscale Serve. No Tailscale identity headers in v1. |
| D4 | How a remote desktop is served | **The server serves the desktop UI** (same build as the server, so no version skew). The client app is a thin native shell around it, like the iOS shell (`docs/ios-shell.md`, "Thin shell"). |
| D5 | Settings a remote desktop keeps for itself | Window-place settings (`PHONE_UNSHARED_SETTINGS`) plus layout, density, privacy mode, chat source and Discord sidebar. Everything else is shared with the server. |
| D6 | Device kind (phone or desktop) | Chosen at pairing (the pairing page reached from `/desktop` pairs a desktop). Both kinds are the owner's own devices. |

## 2. Architecture
```
 Client machine                                   Server machine (macOS / Windows, --server)
 ┌───────────────────────────────┐   HTTPS over   ┌──────────────────────────────────────────────┐
 │ ChattyPop --connect <origin>  │   Tailscale    │ main: hidden main window + Discord view      │
 │  client main (no core, no     │ ─────────────▶ │  PhoneHub ── gateway (phone audience)        │
 │  Discord): server list, tray, │   /desktop     │          └─ desktop gateway (renderer aud.)  │
 │  badge, notifications, save   │   /rpc /events │  companion plugin: HTTP server, pairing,     │
 │  dialogs, panel windows       │   /media ...   │   SSE, push, Tailscale Serve                 │
 │  BrowserWindow ⇢ <origin>/desktop  (page = companion.html in desktop mode, │
 │  preload: window.chattypopShell                renders the host <App/>)    │
 └───────────────────────────────┘                │ core utilityProcess (unchanged)              │
                                                  └──────────────────────────────────────────────┘
```
- Phones keep working as today (`/`, phone audience).
- A remote desktop is a paired device of kind `desktop`. Its calls go through a second gateway with the **renderer
  audience**: the full desktop surface minus calls that need the server's own screen or disk.
- The page a remote desktop loads is the companion's page in desktop mode (`/desktop`). It installs an HTTP
  `RendererApi` and renders the host `App`. In a plain browser it also works; inside the client shell it gets native
  extras through `window.chattypopShell`.

## 3. Phase 1: host contract for remote desktops (repo: ChattyPop)

### 3.1 `src/shared/remote.ts` (new)
What crosses for a remote desktop, whatever transport carries it. Mirrors `src/shared/phone.ts`.
```ts
/** Calls a remote desktop handles itself (its shell or page); they never reach the server. */
export const REMOTE_LOCAL_CALLS = [
  'discord.setSlot', 'discord.setSidebar', 'discord.openChannel',
  'desktop.setBadge', 'desktop.setSplashTheme',
  'media.saveAttachment', 'media.savePdf',
  'openPanelWindow', 'showInMainWindow', 'setUnsaved', 'discardUnsaved',
] as const;

/** Main calls that act on the server's screen or disk: refused for a remote desktop. */
export const REMOTE_REFUSED_MAIN_CALLS: readonly string[] = [
  MAIN_INVOKE.openRouter.signIn,        // opens the server's browser for OAuth
  MAIN_INVOKE.storage.move,             // picks a folder on the server
  MAIN_INVOKE.rules.pickFile,           // picks a file on the server
  MAIN_INVOKE.marketplace.installLocal, // a path on the server
  PLUGINS_OPEN_FOLDER_CHANNEL,
];

/** Every main call a remote desktop may make, by channel: every MAIN_INVOKE channel not local or refused, and restart. */
export const REMOTE_MAIN_CALLS: readonly string[];
export const remoteMayCallMain: (channel: string) => boolean;

/** Discord calls a remote desktop may make: every RendererApi['discord'] method except the live pane's. */
export const REMOTE_DISCORD_METHODS: readonly (keyof RendererApi['discord'])[];

/** Settings a remote desktop keeps for itself (D5); its transport stores them per device. */
export const REMOTE_DEVICE_SETTINGS: readonly string[];
export const isRemoteDeviceSetting: (key: string) => boolean;

/** An event as a remote desktop gets it: every renderer event, except changes to settings it keeps for itself. */
export function remoteAppEvent(e: AppEvent): AppEvent | null;
```
Core calls: a remote desktop may make every `RENDERER_CORE_METHODS` call (no separate list).
Test (`tests/remoteContract.test.ts`): every `RendererApi` member is local, crossing or refused; every `MAIN_INVOKE`
channel is classified; every `SETTINGS_KEYS` value is shared or device-kept; nothing is in two lists.

### 3.2 Main calls reachable by channel
`callMain` (`src/main/ipc/mainCalls.ts`) only knows calls registered with `handleMain`. Convert the sender-independent
`ipcMain.handle` registrations so the hub can reach them (behavior for local windows unchanged):
- `src/main/ipc/discord.ts`: `refreshDirectory`, `suggestChannels`, `setOptIn`, `shownChannel`, `probe`.
- `src/main/ipc/dms.ts`: `friends`, `startDm`, `dmWith`, `addToDm`, `closeDm`, `renameDm`, `muteDm`.
- `src/main/ipc/storage.ts`: `deletePrevious`, `dismissNotice`.
- `src/main/plugins/bundled.ts`: `plugins.callCore` (stamped `'renderer'`), `plugins.callMain`.
Sender-dependent ones stay on `ipcMain` and are local or refused remotely: `setBadge`, `setSplashTheme`,
`saveAttachment`, `savePdf`, `rules.pickFile`, `storage.move`, panel windows, unsaved changes.

### 3.3 `src/main/phone/hub.ts`: a desktop gateway
```ts
export interface PhoneTransport {
  broadcast(e: AppEvent): void;
  notify(request: DeliveredNotification): void;
  /** New, optional: events for remote desktops (remoteAppEvent applied). Absent: the transport serves phones only. */
  broadcastDesktop?(e: AppEvent): void;
  /** New, optional: a fresh pairing code for the server's tray and console (server mode). */
  startPairing?(): Promise<PairingPrompt>;
}

/** What the server's tray shows to pair a device. */
export interface PairingPrompt { code: string; url: string | null; expiresAt: number }

export interface PhoneHubDeps {
  core: Pick<CoreClient, 'call'>;
  discord: () => DiscordCalls;
  main: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  media: MediaHandler;
  active: (pluginId: string) => boolean;
}

export class PhoneHub {
  readonly gateway: PhoneGateway;            // phone audience (unchanged)
  readonly desktopGateway: PhoneGateway;     // new: renderer audience, REMOTE_* lists
  connect(pluginId: string, to: PhoneTransport): { gateway: PhoneGateway; desktopGateway: PhoneGateway; disconnect(): void };
  broadcast(e: AppEvent): void;              // phoneAppEvent → to.broadcast; remoteAppEvent → to.broadcastDesktop
  notify(request: DeliveredNotification): void;
  /** New: asks the connected transport for a pairing code; null when none is connected or it can't pair. */
  startPairing(): Promise<PairingPrompt | null>;
}
```
Desktop gateway routing:
| group | method | goes to |
|---|---|---|
| `core` | any `RENDERER_CORE_METHODS` | `core.call` (settings in `REMOTE_DEVICE_SETTINGS` are handled by the transport before this) |
| `plugins` | `callCore` | `core.call('pluginCall', 'renderer', …)` |
| `plugins` | `callMain` | main plugin sides' `callMain` (new dep `callPluginMain`) |
| `discord` | a `DiscordCalls` method | `discord()[method]` |
| `discord` | other `REMOTE_DISCORD_METHODS` | `main(MAIN_INVOKE.discord[method])` |
| `main` | `remoteMayCallMain(channel)` | `main(channel)` |
| anything else | | `PhoneCallRefused` (transport answers 403) |

`src/main/coreEvents.ts`: no signature change; `toRenderer` already calls `phone.broadcast`, which now also feeds
desktops. Plugin events with the `renderer` audience reach desktops; phone-only ones don't.

### 3.4 Plugin SDK
- `src/plugin-sdk/main/index.ts`: export `PairingPrompt`; `ctx.phone.connect` returns `desktopGateway` too.
- `src/plugin-sdk/shared`: export `REMOTE_DEVICE_SETTINGS`, `isRemoteDeviceSetting`.
- `PLUGIN_SDK_VERSION` 2.34.0 → **2.35.0** (additive). Update the SDK surface record and `docs/plugin-architecture.md` §3.

## 4. Phase 2: renderer runs as a remote desktop (repo: ChattyPop)

### 4.1 Surface model (`src/renderer/src/api.ts`)
```ts
export type WindowSurface = 'desktop' | 'remote' | 'phone';
/** Desktop: the preload's API. Remote and phone: the API a page installed (installApi's `surface`). */
export const windowSurface = (): WindowSurface;
/** Unchanged meaning for permission checks: remote desktops act with the renderer audience. */
export const windowAudience = (): 'renderer' | 'phone';      // phone → 'phone', else 'renderer'
export function installApi(api: RendererApi, surface: 'remote' | 'phone'): void;
```
Call sites: `src/renderer/src/plugins/installedLoader.ts` uses `windowSurface() === 'desktop'` for the `installed://`
scheme (remote and phone load from `INSTALLED_PHONE_PATH`); `ProfileCard.tsx` and `plugin-sdk/renderer/pluginList.ts`
keep `windowAudience()`.

### 4.2 `src/renderer/src/state/ui.ts`
```ts
/** A desktop UI served by a ChattyPop server (html data-surface="remote"). */
export const inRemote: boolean;
/** The live Discord client is in this window: false on a remote desktop (D1) and the phone. */
export const hasLiveClient: boolean;
```
- `state/chat.ts`: `chatSource` is `'archive'` when `!hasLiveClient` (as for `inCompanion` today).
- Panels read `hasLiveClient` and the new `serverOnly(feature)` store (below) to hide the live-pane switch and disable
  refused actions with "Only on the server" (view layer only; CSS by the design agent, law 3).
- `state/serverOnly.ts` (new): `serverOnly(f: 'storageMove' | 'rulePickFile' | 'openRouterSignIn' | 'installLocal' | 'pluginsFolder'): boolean`.

### 4.3 `src/plugin-sdk/renderer/shell/remoteApi.ts` (new)
```ts
/** How a remote desktop page reaches its server: the phone transport plus notifications sent to this device. */
export interface RemoteTransport extends PhoneTransport {
  /** Notices the server sends this desktop over its event stream. */
  notifications(deliver: (n: DeliveredNotification) => void): void;
}

/** Native extras the client app gives the page (src/preload/client.ts). Absent in a browser. */
export interface DesktopShell {
  readonly apiVersion: 1;
  notify(n: DeliveredNotification): void;
  setBadge(unread: UnreadTotals): void;
  /** Downloads `path` on the server (its /media route) with this window's cookie and saves it where the owner picks. */
  saveMedia(path: string, fileName: string): Promise<void>;
  /** Renders a PDF locally (Electron printToPDF) and saves it where the owner picks. */
  savePdf(page: PdfPage): Promise<void>;
  openPanelWindow(panelId: string): void;
  showInMainWindow(channelId: string, messageId?: string, compose?: ComposeIntent): void;
  setUnsaved(on: boolean): void;
  discardUnsaved(): void;
  /** Local commands for this window (a notice clicked, a panel window's show-in-main): open-message. */
  onLocalEvent(listener: (e: AppEvent) => void): () => void;
}

declare const remoteApi: unique symbol;
export type RemoteRendererApi = RendererApi & { readonly [remoteApi]: true };

/** The remote desktop's renderer API: renderer-audience calls travel; local ones use `shell` (or the browser). */
export function createRemoteRendererApi(transport: RemoteTransport, shell: DesktopShell | null): RemoteRendererApi;
/** Installs it (installApi(api, 'remote')) and the media root; then renders the host App (or a panel window). */
export function startRemoteDesktop(api: RemoteRendererApi, mediaRoot: string): void;
```
Behavior of `createRemoteRendererApi`:
| Member | Remote behavior |
|---|---|
| `core.*` | `transport.call({ group: 'core', … })` |
| `discord.setSlot/setSidebar/openChannel` | no-op |
| other `discord.*` | `transport.call({ group: 'discord', … })` |
| `plugins.callCore/callMain` | transport, group `plugins` |
| `storage.move`, `rules.pickFile`, `openRouter.signIn`, `marketplace.installLocal`, `openPluginsFolder` | reject: "Only on the server." |
| other `MAIN_INVOKE` groups | transport, group `main`, by channel |
| `media.saveAttachment` | `shell.saveMedia(mediaPath(sha256, filename), filename)`; browser: download link |
| `media.savePdf` | `shell.savePdf(page)`; browser: `transport.openExport(page, 'pdf')` |
| `desktop.setBadge` | `shell.setBadge`; browser: no-op |
| `desktop.setSplashTheme` | no-op |
| `openPanelWindow`, `showInMainWindow`, `setUnsaved`, `discardUnsaved` | shell; browser: no-op (panel opens in a new tab) |
| `restartApp` | transport (restarts the server, as on the phone) |
| `onEvent` | transport events + `shell.onLocalEvent` |
| notifications | `transport.notifications` → `shell.notify`, else the browser's `Notification` |

Exports from `@plugin-sdk/renderer/shell`: `createRemoteRendererApi`, `startRemoteDesktop`, `RemoteTransport`,
`DesktopShell`, `RemoteRendererApi`.

## 5. Phase 3: companion serves remote desktops (repo: ChattyPop-Plugins-Private, `plugins/companion`)

### 5.1 Devices (`main/devices.ts`, `shared/protocol.ts`)
```ts
export type DeviceKind = 'phone' | 'desktop';
export interface PairedDevice { /* existing fields */ kind: DeviceKind }
// PairedDevices
add(now: number, userAgent: string | undefined, kind: DeviceKind): string;
kindOf(id: string): DeviceKind | null;
```
Stored devices without `kind` read as `'phone'`.

### 5.2 Routes (`main/server.ts`)
| Path | Change |
|---|---|
| `GET /desktop` | Serves `COMPANION_PAGE` (the same page; it starts in desktop mode by its path). Unpaired: redirect to `/pair?kind=desktop`. |
| `/pair` | Form carries `kind` (`phone` default); `pair()` records it. |
| `POST /rpc` | Desktop devices: `this.desktopPrefs.gatewayFor(device)` over `desktopGateway`; phones unchanged. |
| `GET /events` | Desktop devices get `broadcastDesktop` events; phones get `broadcast` events. Notices for desktops come as `event: notification` frames. |

### 5.3 Server class
```ts
export class CompanionServer implements PhoneTransport {
  broadcast(e: AppEvent): void;                 // phones
  broadcastDesktop(e: AppEvent): void;          // new: desktop devices' streams
  notify(request: DeliveredNotification): void; // phones: push (as today); desktops: SSE `notification` frame
  startPairing(): Promise<PairingPrompt>;       // existing PairingCode, now also through the hub
}
```
- `EventStreams` gets the device kind per stream and routes by it; replay keeps both.
- `main/desktopPrefs.ts` (new): `DesktopSettings.gatewayFor(device)` keeps `REMOTE_DEVICE_SETTINGS` per device
  (`ownSetting`/`setOwnSetting`), sends their changes to that device only.
- Settings → Phone (`renderer/PhoneSection.tsx`) lists the device kind; a desktop row has no push or quiet-hours controls.

### 5.4 Page (`page/`)
- `page/surface.ts` (new, the first import in `main.tsx`): when `location.pathname === '/desktop'`, sets
  `<html data-surface="remote">` before any host module evaluates (`inCompanion`/`inRemote` read it at load).
- `page/main.tsx`: desktop mode does `await import('./desktop')` (its own chunk, so the phone bundle stays as is).
- `page/desktop.ts` (new): builds a `RemoteTransport` on the existing `/rpc`, `/events`, `/pages` and the new
  `notification` frames, then `startRemoteDesktop(createRemoteRendererApi(transport, window.chattypopShell ?? null), COMPANION_PATHS.media)`.
- CSP of `page/index.html` is unchanged (`connect-src 'self'`).

## 6. Phase 4: server mode (repo: ChattyPop)

### 6.1 `src/main/launchMode.ts` (new)
```ts
export type LaunchMode = { kind: 'app' } | { kind: 'server' } | { kind: 'client'; origin: string | null };
/** From argv (`--server`, `--connect[=<https origin>]`) or CHATTYPOP_MODE (`server` | `client`); app otherwise. */
export function launchMode(argv: readonly string[], env: NodeJS.ProcessEnv): LaunchMode;
```
`src/main/index.ts`: `client` → `await import('./client/clientApp')` (no installed-plugin decision, no core);
otherwise as today, passing the mode to `app.ts` through `process.env.CHATTYPOP_MODE`.

### 6.2 Server behavior (`app.ts`, `desktop.ts`, `mainWindow.ts`, `tray.ts`)
- `Desktop` takes `serverMode: boolean`: `startHidden` is true, `closeToTray()` returns true; the window can still be
  opened from the tray for first-time setup (enable Settings → Phone, sign in to Discord).
- macOS: `app.dock.hide()` while the window is hidden.
- No splash in server mode (`startSplash` skipped).
- Notifications: `notificationService({ desktop: serverMode ? () => {} : … })`; remote desktops and phones get them
  through the transport.
- `AppTray` menu (server mode): `Server: <published URL or why not>`, `Pair a device…`, `Open ChattyPop`,
  `Restart`, `Quit`.
  ```ts
  export interface TrayActions { open(): void; restart(): void; quit(): void; pair?(): void }
  export class AppTray { setServerStatus(status: { url: string | null; error: string | null } | null): void }
  ```
  `pair` calls `phone.startPairing()` and shows the code in a small native dialog and in the diagnostics log; with
  `--server --pair` it also prints the code and URL to stdout.
- Quit stays graceful (tray Quit → `closeFromCode(win)`), so the Discord login is flushed.

## 7. Phase 5: client app (repo: ChattyPop)

### 7.1 Main side, `src/main/client/` (new)
```ts
// servers.ts: saved servers in the profile (servers.json)
export interface SavedServer { origin: string; name: string; lastUsedAt: number }
export class ServerList {
  list(): SavedServer[];
  add(origin: string, name?: string): SavedServer;   // https origins only
  remove(origin: string): void;
  touch(origin: string): void;
}
export function normalizeOrigin(input: string): string | null;

// clientWindow.ts
/** A window on `origin`'s desktop page (or one panel); its own persistent session per server keeps the pairing cookie. */
export function openServerWindow(origin: string, opts?: { panel?: string }): BrowserWindow;
// session partition: `persist:server-${sha256(origin).slice(0, 16)}`
// navigation: same origin only; other links → shell.openExternal; exports (/pages/) open in the system browser
// permissions: 'notifications' and 'clipboard-sanitized-write' for that origin only

// shellHandlers.ts
/** Serves window.chattypopShell's calls; each checks the sender is a server window of that origin. */
export function registerShellHandlers(windows: ServerWindows): void;

// clientApp.ts
/** Client mode: opens the last server (or the connect page), plus tray, badge and graceful quit. */
export function startClient(mode: { origin: string | null }): void;
```
- `connect.html` (new host renderer page, `src/renderer/connect.html` + `src/renderer/src/connect/`): add, pick and
  remove servers. Its preload API: `window.chattypopConnect = { list(), add(origin), remove(origin), open(origin) }`.
  Added to `HOST_PAGES` in `bundledPlugins.ts`. CSS module by the design agent (law 3).
- Badge: reuse `badgeImage.ts` (Windows overlay) and `app.setBadgeCount` (macOS).
- PDF: reuse `src/main/pdf.ts` (`htmlToPdf`) in the client.

### 7.2 Preload, `src/preload/client.ts` (new, built as `client.cjs`)
- Exposes `window.chattypopShell: DesktopShell` (4.3) through `contextBridge` only when `location.origin` equals the
  origin main passed in `additionalArguments` (`--cp-server-origin=<origin>`).
- `src/preload/connect.ts` (new) exposes `window.chattypopConnect` for `connect.html` only.
- `electron.vite.config.ts`: preload inputs `index`, `client`, `connect`.

### 7.3 IPC channels (`src/shared/types/ipc.ts`)
```ts
export const SHELL_INVOKE = {
  notify: 'shell:notify', setBadge: 'shell:set-badge', saveMedia: 'shell:save-media', savePdf: 'shell:save-pdf',
  openPanelWindow: 'shell:open-panel', showInMainWindow: 'shell:show-in-main',
  setUnsaved: 'shell:unsaved', discardUnsaved: 'shell:discard-unsaved',
} as const;
export const SHELL_LOCAL_EVENT_CHANNEL = 'shell:local-event';
export const CONNECT_INVOKE = { list: 'connect:list', add: 'connect:add', remove: 'connect:remove', open: 'connect:open' } as const;
```

## 8. Phase 6: Discord sign-in from a client (repo: ChattyPop)
Spike first: whether a hidden window's Discord view produces screencast frames (background throttling).
```ts
// src/main/discord/loginRelay.ts
export interface RelayInput { kind: 'mouse' | 'key' | 'text' | 'wheel'; /* CDP Input.dispatch* fields */ }
export class LoginRelay {
  constructor(view: DiscordView, emit: (e: AppEvent) => void);
  start(): Promise<void>;   // Page.startScreencast {format:'jpeg', quality:60, maxWidth:1280, everyNthFrame:2}; view un-throttled
  stop(): void;             // Page.stopScreencast; throttling restored
  input(e: RelayInput): Promise<void>; // Input.dispatchMouseEvent / dispatchKeyEvent / insertText
}
// AppEvents (desktop gateway only; never to phones)
{ type: 'discord-login-frame'; data: string /* base64 jpeg */; width: number; height: number }
{ type: 'discord-session'; state: 'signed-in' | 'signed-out' }   // from HeaderCapture.onAvailable and gateway op 9
// RendererApi.discord: loginStart(): Promise<void>; loginStop(): Promise<void>; loginInput(e: RelayInput): Promise<void>
// MAIN_INVOKE.discord: loginStart, loginStop, loginInput (handleMain; remote and local)
```
View: a "Sign in to Discord on the server" panel on remote desktops while `discord-session` is `signed-out`
(store `state/discordSession.ts`; canvas view; CSS by the design agent).

## 9. Tests and checks
- Host: `pnpm typecheck`, `pnpm test`, plus new tests:
  - `tests/remoteContract.test.ts` (3.1),
  - `tests/phoneHubDesktop.test.ts` (3.3 routing and refusals, events reach desktops but not phones and back),
  - `tests/remoteRendererApi.test.ts` (4.3 table, shell and browser fallbacks),
  - `tests/launchMode.test.ts`, `tests/serverList.test.ts`,
  - `tests/clientPreloadOrigin.test.ts` (shell exposed only on the expected origin).
- Companion: its tests (`tests/companionServer.test.ts` and new desktop-device tests) and
  `pnpm plugin:check <plugins dir>` against this branch.
- End to end in the cloud container (Linux, Xvfb): `--server` and `--connect` on one machine; pair; core calls,
  events and media through the client window. No Discord login there, so ingest is not covered.
- macOS and Windows: the existing CI jobs (`windows-latest`, macOS) run typecheck and tests on every push.

## 10. Commit order (small commits, types set the version bump)
1. `feat: remote desktop contract (shared/remote.ts)`.
2. `refactor: main calls reachable by channel for remote desktops`.
3. `feat: the phone hub carries remote desktops (desktop gateway, events, pairing prompt)`.
4. `feat: plugin SDK 2.35: desktopGateway, broadcastDesktop, startPairing`.
5. `feat: the renderer runs as a remote desktop (surface, remote API, archive-only chat)`.
6. Companion: `feat: desktop devices`, `feat: /desktop page and desktop event streams`, `feat: notices to desktops`.
7. `feat: server mode (--server)`.
8. `feat: client mode (--connect), server list and connect page`.
9. `feat: Discord sign-in relay for remote desktops` (after the spike).
10. `docs: remote server and client (docs/remote.md, §0, plugin-architecture §3)`.

## 11. Needs from the owner
- **Push access to Cujuju/ChattyPop-Plugins-Private** for this session (phase 3). Read access is attached; the push
  request was refused by the session's permission check.
- Decisions D1 to D6 (defaults above).
- After merge, on your machines: first-run setup on the server (enable Settings → Phone, sign in to Discord or use
  phase 6), pairing a desktop, and a real Tailscale run.

## 12. Out of scope here
Multi-server (lease and replay log), Linux packaging, whisper.cpp builds for Linux and macOS, VRAM measurement.
