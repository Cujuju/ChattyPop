# iPhone shell (Capacitor)

A thin native iPhone app around the phone page a phone transport plugin serves (`docs/plugin-architecture.md` §3,
phone transport), plus a share target that posts to a Discord channel.
Sideloaded from Xcode or TestFlight; never the App Store.

The shell's side of the contract is `src/shared/shell.ts` (exported by `@plugin-sdk/shared`). The routes, pairing and
pushes below are the transport's: this doc states what the shell expects of it, not how a transport builds them.

## Decisions
- **Thin shell.** The web view loads the paired desktop's phone page. UI and data stay on the desktop; only a welcome
  page and an offline page are bundled.
- **The address comes from pairing, not the build (phase C).** The pairing link carries the desktop's origin, and the
  app saves it in UserDefaults. Builds contain no desktop address.
- **Pairing by Camera (phase C).** The Camera opens an `https` QR in Safari, whose cookies the app can't see. So the
  pairing page offers "Open in the ChattyPop app", a `chattypop://pair?origin=…&code=…` link that the app handles.
  There is one QR for both the web app and the native app. Typing the code in the app still works.
- **One display mode.** `browser | standalone | shell` is decided in one place and published as
  `<html data-display>`. CSS and the install banner read it, instead of scattered `display-mode` media queries.
- **Keyboard:** the web view stays full-window and the page moves itself, as a native app's content does. On each keyboard
  announcement `ShellViewController` sets `--cp-keyboard-inset` (how far the keyboard covers the page) and
  `--cp-keyboard-duration` (iOS's duration for that move) on `<html>`; `<html>` eases the inset over that time with
  `--cp-ease-keyboard` (an approximation of iOS's private curve), so whatever pads itself above the keyboard rides it.
  `--cp-safe-bottom` is the home-bar inset less the keyboard's cover. The web view is never resized: WebKit draws an
  animated resize at the final size inside the moving frame, which pushes the page down. While the keyboard is up or
  moving, WebKit's scroll of the whole web view to reveal the focused field is undone. The plugin's `resize` is `'none'`:
  its `'native'` resize waited for the keyboard's animation plus 0.2 s. The accessory bar (⌃⌄✓) is hidden, and the
  keyboard follows the theme's colour scheme. The page posts its `--cp-surface-1` as `{ r, g, b }` to the native
  `shellBackdrop` handler, which paints the window with it (`#090b10` until the first post).
- **Network:** WebKit has no `navigator.connection`, so the app dispatches `SHELL_NETWORK_EVENT` (`cp-shell-network`,
  detail `{ cellular: boolean }`) on `window` on each network change, and in reply to the page posting `{}` to the
  `shellNetwork` handler (`SHELL_NETWORK_HANDLER`), which `state/network.ts` does once when it loads. Data Saving reads
  it to send videos at Data Saver quality on cellular.
- **Push:** Web Push doesn't exist in WKWebView, so the shell uses APNs (phase D). The home-screen web app keeps Web Push.
- **Share auth reuses the phone's pairing.** The app copies the transport's pairing cookie (`cp_companion`) into a shared
  Keychain item, and the extension sends it. No new credential kind, and unpairing the phone on the desktop cuts the
  extension off too.
- Bundle id `com.cujuju.chattypop` (`SHELL_BUNDLE_ID`), extension `com.cujuju.chattypop.share`, Keychain group
  `$(AppIdentifierPrefix)com.cujuju.chattypop.shared`. (Assumption: change them if the developer account uses another prefix.)

## Phase A — basic shell
1. **Config and project**
   - `capacitor.config.ts`: appId, appName `ChattyPop`, `webDir: 'mobile/www'`, `server.errorPath: 'offline.html'`,
     `appendUserAgent: SHELL_USER_AGENT_TOKEN`, `ios.contentInset: 'never'`, `plugins.Keyboard.resize: 'none'`.
   - The committed iOS project uses Capacitor's SPM template. The controller supplies the saved origin at runtime.
2. **Bundled pages:** Vite builds `mobile/index.html` (welcome) and `mobile/offline.html` into ignored `mobile/www/`.
   - Both link the host theme's `pair.css`; Vite bundles its tokens and styles.
   - Offline Retry posts to the native `shellRetry` handler, which reloads the saved origin.
   - `pnpm shell:sync` runs Vite and `cap sync ios`; no environment variable is needed.
3. **Chrome (the phone page):** browser and native chrome are tinted in one theme effect.
   - The shell hides the keyboard accessory bar once and updates keyboard/status-bar styles from `--cp-color-scheme`.
4. **Display mode (the phone page):**
   - The display mode is computed once and set as `html[data-display]` before render.
   - CSS, the installed check and the install banner use that mode. The shell counts as installed.
   - Push reports `unsupported` in a shell built before phase D.
5. **Native (`ios/App/App`):** `ShellViewController: CAPBridgeViewController`, set as the root in `SceneDelegate`. It:
   - observes `WKHTTPCookieStore` for the pairing cookie on the server host;
   - mirrors `{origin, token}` into the shared Keychain item and deletes the item when the cookie goes away.

   This is used by phase B, but lives in the app target. The new file is added to `project.pbxproj` by hand
   (file ref, build file, group, sources phase).
6. **Icon:** the app icon comes from the phone page's install icon, 1024×1024 if one exists; otherwise that's a Mac step.

## Phase B — share to a channel
1. **Contract (the transport's `/share` route):**
   - `GET` returns the share targets: the phone's own channel list (opted-in text channels by server), privacy filtered
     exactly as the phone's Channels panel sees it.
   - `POST` takes JSON `{ channelId, text }`, which is checked:
     - JSON only;
     - the channel must be among the targets;
     - the text is trimmed, non-empty and within Discord's message limit.

     A valid post is sent through the same `discord.send` path and argument shape as the phone composer. Errors come
     back as `{ error }` with a 4xx/5xx status.
2. **Server:** a route behind the transport's existing pairing-cookie check. There is no new auth path.
3. **Tests (the transport's):** contract level:
   - 401 without a cookie;
   - the targets list;
   - hidden and not-opted-in channels are excluded;
   - validation rejects bad input;
   - `send` is called with the composer's shape.
4. **Extension (`ios/App/ShareExtension/`):** a SwiftUI view in a `UIViewController`.
   - It shows the shared URL or text in an editable field, a channel picker loaded from `GET /share`, Cancel and Send.
   - Errors:
     - PC off: "Can't reach your PC".
     - 401: "Open ChattyPop to pair".
   - It accepts one web URL or plain text (activation rules in Info.plist).
   - `ShareExtension.entitlements` and `App.entitlements` carry the Keychain group.
5. **Mac step, needed once:** in Xcode, add a Share Extension target named `ShareExtension`, replace its files with
   the committed ones, and enable Keychain Sharing on both targets. This isn't hand-edited into `project.pbxproj`:
   creating a target blind is too fragile.

## Phase C — pairing through the app's link
Replaces phase A's build-time address.
1. **Contract (`src/shared/shell.ts`):**
   - `SHELL_SCHEME = 'chattypop'`, and the link `chattypop://pair?origin=<https origin>&code=<digits>` (`shellPairLink`),
     with its parameter names as constants.
   - `SHELL_USER_AGENT_TOKEN`, which the shell appends to its user agent (`appendUserAgent`), so the server can tell
     it's talking to the app.
2. **Pairing page (the transport's):**
   - With a code prefilled (it came from the QR) and outside the shell, it shows an "Open in the ChattyPop app" link.
     The link carries the server's public origin and the code, escaped.
   - Inside the shell, the page stays as it is (typed or prefilled code).
   - The button can't know whether the app is installed. The page says what it's for.
3. **Native:**
   - `SceneDelegate` sends links to `ShellViewController`, both at launch (`connectionOptions.urlContexts`) and while
     running (`openURLContexts`).
   - A valid link is:
     - scheme `chattypop`, host `pair`;
     - an `origin` that's `https`, has a host ending in `.ts.net` (Tailscale Serve is the only way the desktop is
       exposed), and has no path, query or user info;
     - a `code` of digits only. The server checks the code itself.
   - Links are **always confirmed**: "Pair with ‹host›?", adding "This replaces ‹old host›." when one is saved. Any
     website or app can fire the link, and Tailscale Funnel makes `*.ts.net` hosts public.
   - Once confirmed, the origin is saved in `UserDefaults` (it isn't secret) and the root is rebuilt as a new
     `ShellViewController`.
   - `ShellViewController.instanceDescriptor()` sets `serverURL` from the saved origin. The page then gets the
     Capacitor bridge and `errorPath` exactly as it would with `server.url`, and the app loads `/pair?code=…` first.
   - With no saved origin, the bundled `index.html` shows "Scan the pairing QR on your PC with the Camera".
   - Offline Retry: `offline.html` posts to a `shellRetry` script message handler that `ShellViewController`
     registers, which reloads the saved origin. There's no build-time address anymore.
   - The Keychain mirror (phase A) takes its origin from the saved one.
4. **Config:** `capacitor.config.ts` drops `server.url` and the env var, and adds `appendUserAgent`. `mobile/www` now
   builds `index.html` (welcome) and `offline.html`, both styled with `pair.css`.
5. **Tests:**
   - The pairing page shows the app link only with a prefilled code and outside the shell.
   - The link's origin is the public URL and its code is the prefilled one, both escaped.
   - Swift's link validation is checked in review and on the device.
6. **Residual risk:** another installed app could register `chattypop://` and read a code. Codes must be short-lived
   and single-use, and the app confirms the host before pairing.

## Phase D — native push (APNs)
1. **Contract (the transport's `/push`):** `PUT /push` takes `{ apns: { token, environment }, kinds }` beside the Web
   Push `{ subscription, kinds }`. `GET /push` returns `address` (endpoint or device token) and `apns` (the PC holds an
   Apple key). `DELETE /push` stops pushes to this phone.
2. **Sender (the transport's):** pushes name `SHELL_BUNDLE_ID` as their topic. The Apple key is the owner's, set on the
   PC and never in the repo. A token APNs rejects is forgotten; the app sends a new one when it next opens.
3. **Environment:** simulator builds use development. Otherwise the app reads `aps-environment` from its provisioning profile. With no profile (TestFlight or App
   Store) it uses production. It exposes the value to the page as `window.chattyPopShell.apsEnvironment`
   (`SHELL_NATIVE_GLOBAL`), which the page sends with the token.
4. **Page:** `@capacitor/push-notifications` handles the permission, the token and taps. A tap opens the notice's
   message or panel, as the service worker does. An app built before phase D reports push as unsupported.
5. **Sender check:** each APNs push carries the sending desktop's origin, and a tap opens its target only when that is
   the page's own origin.
   - Re-pairing: before switching, the app sends `DELETE /push` to the previously paired PC with its pairing
     cookie (shared Keychain), so that PC stops pushing. Best effort: a PC that is off or unreachable then keeps
     sending until the phone is signed out there. The home-screen web app has no such step.
   - Page push changes run one at a time, so a refresh never re-sends choices a tap has since replaced.
6. **Native:** `AppDelegate` forwards the registration callbacks to the plugin, and `App.entitlements` carries
   `aps-environment`.
   - A tap that launches the app arrives in the scene's `connectionOptions.notificationResponse`, before Capacitor's
     notification delegate exists. `ShellViewController.capacitorDidLoad` hands it to the bridge's router.

## Mac runbook
1. `pnpm install`
2. `pnpm shell:sync` (no desktop address or environment variable).
3. `npx cap open ios`: do the one-time Xcode setup below, then run on the iPhone.
   Signing: put `DEVELOPMENT_TEAM = <team id>` in the gitignored `ios/App/Signing.xcconfig`; `App/Project.xcconfig` includes it for both targets. Never commit a team id.
4. Pair: scan the desktop's QR with the Camera, tap "Open in the ChattyPop app" and confirm the host. Or type the code
   in the app.

## Verification
- Windows: `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm shell:sync` (config and offline page; the Xcode
  steps are skipped).
- Swift isn't compiled on Windows. It's checked in review and first built on the Mac.
- On a device:
  - Keyboard: no bar, themed, top bar stays.
  - Status bar text is readable on every theme.
  - Offline page appears when the PC is off.
  - External links open in Safari.
  - Pull to refresh works.
  - Share: from Safari to a channel, and from Notes to a channel.
  - Pairing: a Camera scan leads to the app link, then the confirm, then paired. A second PC's link asks before
    replacing the first. Bad links (http, not `ts.net`, a path) are ignored.
  - Push: with a key added on the PC, turn on a notice kind in the bell sheet and allow notifications. An alert arrives
    with the app closed and with it open, and a tap opens its message. Removing the key shows the PC-setup note.

## One-time Xcode setup
- Add an iOS Share Extension target named `ShareExtension`, bundle id `com.cujuju.chattypop.share`, deployment target iOS 17.0.
- Remove the generated extension controller and storyboard from the target. Add the committed
  `ios/App/ShareExtension/ShareViewController.swift` to the extension target only.
- Add `ios/App/App/SharedPairing.swift` to **both** targets. Keep `ShellViewController.swift` in App only.
- Set the extension's Info.plist File to `ShareExtension/Info.plist`; disable Generate Info.plist File.
  The committed plist uses a principal class, not a storyboard.
- Add the Push Notifications capability to App (not ShareExtension); it uses `App/App.entitlements`' `aps-environment`.
- Enable Keychain Sharing on both targets with `$(AppIdentifierPrefix)com.cujuju.chattypop.shared`.
  Use `App/App.entitlements` and `ShareExtension/ShareExtension.entitlements` as their Code Signing Entitlements.
  Both Info.plists expand the same group through `SharedKeychainGroup`.
- Confirm App embeds ShareExtension, both use the same signing team, and their version/build numbers match.
- Resolve Swift packages after sync. Assumption: the configured bundle ids are available to your signing team;
  confirm in Signing & Capabilities and update both targets together if necessary.
- If the phone page has only 192/512-pixel install icons, replace the template AppIcon with a 1024×1024 icon on the Mac.

## Implementation notes
- `/share` reads the core `directory` query, which applies privacy mode, then keeps opted-in, non-thread text channels.
  It posts the same `OwnerMessage` object as the phone composer through `discord.send`.
- The extension takes the first web URL across shared attachments, otherwise the first plain text. It uses an ephemeral
  session, supplies only the paired cookie, and refuses redirects. The server enforces message length.
- The app observes cookie changes using WKHTTPCookieStoreObserver
  ([Apple API](https://developer.apple.com/documentation/webkit/wkhttpcookiestoreobserver)).
- Native compilation, signing, Keychain sharing, extension activation, keyboard/status bar, offline recovery,
  external links, pull to refresh, and sharing from Safari/Notes require the Mac/device verification above.
