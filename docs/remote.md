# Remote server and client

ChattyPop can run as a **server** on one computer (macOS or Windows first; Linux works headless under Xvfb) and serve
its full desktop UI to **clients** on other computers, over Tailscale or a private network. Phones keep working as
before. Plan and decisions: `docs/server-client-split-plan.md`; issue #132.

## How it fits together
- **The server** is the app as it is (core, the archive, plugins, the embedded Discord client), started with
  `--server`: its window starts hidden, closes to the tray, and the app runs until Quit (§0 Rules). Notices go to its
  devices, not to its own screen. On macOS it is a menu-bar app; its dock icon shows only while its window does.
- **The phone transport** (a plugin, `phone.transport`) serves devices over HTTPS through Tailscale Serve. A device
  pairs with a one-time code and is a **phone** (the phone's page, pushes) or a **desktop** (the desktop UI, as a
  window). A desktop opens `/desktop`: the transport's page marked `data-surface="remote"`, which starts the host's
  desktop UI over the transport (`startRemoteDesktop`, `@plugin-sdk/renderer/shell`). The page always matches the
  server's version.
- **A desktop's calls** go through the hub's desktop gateway (`src/main/phone/hub.ts`): the renderer audience, every
  window call except what needs the server's screen or disk (`src/shared/remote.ts`). It keeps its own layout,
  density, privacy mode and window place (`REMOTE_DEVICE_SETTINGS`); every other setting is the server's.
- **The client** is the app started with `--connect`: no core, no Discord, no plugins. It keeps a list of servers,
  a session per server (its pairing cookie), and a thin native shell around the server's page
  (`src/shared/desktopShell.ts`): notices, the badge, saving files and PDFs, panel windows. The shell is given only to
  the server a window opened.
- **The live Discord pane** is on the server's screen only. A remote desktop shows the Archive; while the server's
  Discord is signed out, its Chat panel offers a **sign-in relay**: the server's Discord page as frames, the owner's
  pointer and keys sent back (`src/main/discord/loginRelay.ts`). A hidden window paints nothing, so while a relay runs
  the server shows its window without focus. A relay runs only while the server's Discord is signed out; a desktop
  that opens or reloads while one runs shows it, with its latest frame.

## Running a server
1. Install ChattyPop on the server and start it once normally: sign in to Discord, choose archived channels, install
   the phone transport plugin and turn on **Settings → Phone** (Tailscale with Serve and HTTPS on).
2. Start it as a server: `ChattyPop --server` (or `CHATTYPOP_MODE=server`). In development: `pnpm dev -- --server`.
   Add `--pair` to print a pairing code to the terminal once it serves.
3. To pair a device, choose **Pair a device…** in the tray or menu-bar icon: Settings → Phone opens with a code.
4. The server keeps running until **Quit** in its tray menu, which closes it gracefully (the Discord login is kept).

## Running a client
1. Start ChattyPop with `--connect` (or `CHATTYPOP_MODE=client`), or `--connect=<server>` to open one directly, e.g.
   `--connect=pc.example.ts.net:8443`. Only https servers are accepted.
2. The first time, the server's pairing page asks for a code: make one on the server (tray → Pair a device…).
3. **File → Connect to a server…** adds or picks another. A server that can't be reached opens that page with the
   reason and Try again.
4. The client's profile is its own (`ChattyPop Client` beside the app's, or `CHATTYPOP_CLIENT_PROFILE_DIR`), so a
   client runs beside the app or a server on the same computer.

A desktop browser can open `https://<server>/desktop` too; it gets the same UI without the native extras (notices
while the tab is open and allowed, downloads in place of save dialogs, panel windows as tabs).

## Network
Tailscale is the supported transport: Serve publishes the server's loopback port with a trusted certificate, and only
the tailnet reaches it. A private VPN works if it gives the server an https origin the client trusts (Serve, or your
own reverse proxy and certificate); the client never accepts plain http.

## Limits
- Moving the archive, the rule file picker, OpenRouter sign-in and the plugins folder need the server's screen; a
  remote desktop says "Only on the server". A typed path (a rule file, a local plugin) works.
- A sign-in relay sends JPEG frames (about 40 KB each) through the transport's event stream while it runs; it stops
  once signed in, when stopped, or after ten minutes. A frame is momentary: the hub tells the transport so, and the
  transport keeps none for a desktop that reconnects.
- Several servers sharing one archive is not supported (see the plan's out-of-scope list).
