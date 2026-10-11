# iPhone emoji image cache

The iPhone app will retain custom emoji images in its own storage, download missing images from the paired desktop,
and evict old files within a byte budget. Retained images must survive app restart and removal of WebKit's image
caches. The shared renderer, native storage, downloader, loader, cookie observer, and scheme handler are implemented.
The interfaces and policies below describe the implementation.

This phase uses eviction by size and explicit native removal. Catalog completeness, catalog membership messages,
and automatic removal after an emoji disappears from the catalog belong to the next phase. The existing desktop
media endpoint and phone page CSP already support this implementation.

## Shared renderer interface

`src/shared/shell.ts` defines:

~~~ts
SHELL_CAPABILITIES.emojiCache = 'emojiCache';
SHELL_ASSET_HOSTS.emoji = 'emoji';
SHELL_EMOJI_SOURCE_ROOT = '/media/';
SHELL_EMOJI_CACHE_VERSION = 1;
SHELL_EMOJI_CACHE_ROOT = 'chattypop-asset://emoji/v1/';
~~~

The existing `installRendererApi(api, mediaRoot)` enables native emoji routing when the installed app lists
`emojiCache` and `mediaRoot` is `/media/`. The shared `emojiUrl` then produces:

~~~text
chattypop-asset://emoji/v1/<emoji-id>.webp
chattypop-asset://emoji/v1/<emoji-id>.gif
~~~

Other media routes keep their existing URLs. A browser, an older app, or a transport with another media root keeps
its own emoji URLs. Replacing the media root clears the native override. Routing is set before queued renderer
calls are released, so startup data uses the correct URLs.

The internal media configuration interface is:

~~~ts
setMediaRoot(root: string, routeRoots?: Readonly<Record<string, string>>): void;
~~~

Each override is a complete prefix for one route. The phone initialization supplies
`{ emoji: SHELL_EMOJI_CACHE_ROOT }`. Existing callers retain their original behavior.

The descriptor SDK is 2.36.0 for the additive capability contract. No new SDK export names are needed.
The Swift app advertises `emojiCache` after registering the v1 handler. Each load awaits storage recovery and
pairing initialization. The cookie observer is registered before the first page starts loading.

`emojiCache` promises v1 support. A future representation version needs a new capability or explicit version
negotiation before a renderer selects its URL prefix; changing the shared version constant alone would break
an installed v1 app.

## Native asset and pairing types

Use Foundation types in the storage and download layers. Keep WebKit and controller references in the serving
layer so the storage policy can be tested independently.

~~~swift
enum EmojiRepresentation: String, Codable, Sendable {
    case webp
    case gif
}

struct EmojiAssetKey: Hashable, Codable, Sendable {
    let id: String
    let representation: EmojiRepresentation
    let version: Int

    init?(assetURL: URL)
}

struct EmojiAsset: Sendable {
    let data: Data
    let contentType: String
}

struct EmojiPairingContext: Sendable {
    let origin: URL
    let namespace: String
    let generation: UUID
    let cookieHeader: String
}
~~~

`EmojiAssetKey.init(assetURL:)` accepts only the asset scheme, host `emoji`, version segment `v1`, and a
15–21 digit ID followed by `.webp` or `.gif`. Reject user information, a port, query parameters, fragments,
extra path segments, and encoded path separators. Version 1 preserves the desktop's current 128 px images.
An animated emoji may have both representations; retain and evict them as distinct files.

Build the source URL inside native code as `<paired-origin>/media/emoji/<id>.<representation>`. The page supplies
only an asset key. Source hosts and arbitrary download paths never come from image parameters.

A namespace binds the normalized HTTPS origin and pairing cookie, using a SHA-256 fingerprint. The generation
identifies the current controller/pairing lifetime. Keep the cookie only in memory and the existing pairing
Keychain; never put it in filenames, the index, or diagnostics.

`ShellViewController` obtains the context from its existing `WKHTTPCookieStore`. Coalesce the initial cookie
lookup and retain a validated snapshot through the existing cookie observer. A load waits for the initial
lookup instead of treating an unfinished lookup as an unpaired device. Compare origins using their effective
port, including HTTPS's default port of 443.

## Storage interface and policy

Suggested initial policy, owned by native code:

~~~swift
struct EmojiCachePolicy: Sendable {
    let diskBytesMax: Int       // 128 * 1024 * 1024
    let memoryBytesMax: Int     // 16 * 1024 * 1024, encoded bytes
    let assetBytesMax: Int      // 8 * 1024 * 1024
    let downloadsMax: Int       // 4 unique downloads
    let queuedDownloadsMax: Int // 256 unique pending downloads
    let requestTimeout: TimeInterval  // 30 seconds
    let resourceTimeout: TimeInterval // 60 seconds
}

struct EmojiWritePermit: Sendable {
    let key: EmojiAssetKey
    let namespace: String
    let generation: UUID
    let revision: UInt64
}

struct EmojiStorageStats: Sendable {
    let entries: Int
    let imageBytes: Int
    let totalStorageBytes: Int
    let recoveryRemovals: Int
    let sizeEvictions: Int
    let writeFailures: Int
}

protocol EmojiStore: Sendable {
    func recover() async throws
    func activate(namespace: String, generation: UUID) async
    func deactivate(generation: UUID) async
    func beginLoad(
        _ key: EmojiAssetKey, namespace: String, generation: UUID
    ) async -> EmojiWritePermit?
    func read(_ key: EmojiAssetKey, namespace: String) async throws -> EmojiAsset?
    func touch(_ key: EmojiAssetKey, namespace: String) async
    func write(_ asset: EmojiAsset, permit: EmojiWritePermit) async throws
    func remove(ids: Set<String>, namespace: String) async throws
    func trim(to maximumBytes: Int) async throws
    func clear(namespace: String) async throws
    func flush() async throws
    func stats() async -> EmojiStorageStats
}
~~~

Implement `ShellEmojiStore` under `Library/Application Support/com.cujuju.chattypop/emoji/v1/<namespace>/`.
Use `<id>.webp` and `<id>.gif` filenames. Mark the directory and newly committed files excluded from backups;
these are downloadable assets. Keep the index in the same excluded storage tree.

An index entry records the namespace, key, encoded byte count, SHA-256 checksum, and last access time. MIME type
follows the validated representation. The filesystem contains the durable bytes; index loss must not orphan
otherwise valid images.

The concrete store serializes mutation and performs file I/O away from the main thread. Write through a
temporary sibling file, validate it, then atomically rename it into place. Only publish a committed entry in
the index. Batch access-time/index writes, and flush on backgrounding. Correctness must survive termination
between any file and index writes.

The loader obtains a write permit when a coalesced load begins, before downloading. The store validates that
permit immediately before committing the file, in the same serialized mutation context as removal and
pairing deactivation. `remove(ids:)` advances the affected IDs' revisions; `deactivate(generation:)` rejects
that context's permits. A stale permit abandons its temporary file. A check in the loader before awaiting a
write is insufficient: invalidation can occur while that write waits.

Recovery runs once per store, and image loads await it. Remove abandoned temporary files, reconcile indexed
files against actual sizes and checksums, recover valid unindexed files, and apply the byte cap. Use file
modification times as an initial ordering when rebuilding a lost index. Recovery and trimming never block
the main thread.

Before storing a new file, evict least-recently-used entries until the incoming file fits. The disk cap applies
to the complete emoji storage tree, including index and staging files; reserve staging/index headroom and
allow only one storage commit at a time. Reserve space before writing temporary files. A failed reservation
or write still allows the downloaded image to display without persistence. Download bodies are bounded in
memory separately from the disk budget.

Reads and memory-hit `touch` calls update access time. A missing or corrupt file is removed from the index and becomes a miss. No time
expiry or conditional revalidation applies to successful stored images. `remove(ids:)` removes every
representation of those IDs; the loader must invalidate matching memory entries and pending writers too.
It is available for future catalog integration but this phase has no catalog caller.

The encoded memory cache has its own cost limit and is cleared on memory warnings. WebKit's decoded image
memory and active download buffers are additional memory use; the 16 MiB limit applies to this cache only.

## Download interface

~~~swift
protocol EmojiDownloader: Sendable {
    func download(
        _ key: EmojiAssetKey,
        context: EmojiPairingContext,
        policy: EmojiCachePolicy
    ) async throws -> EmojiAsset
}
~~~

`ShellEmojiDownloader` uses one ephemeral `URLSession` with `urlCache = nil`,
`httpCookieStorage = nil`, and automatic cookie handling disabled. Set only the pairing cookie from the
validated context. Requests use the existing desktop media endpoint. Reject redirects and accept only a
200 response with the representation's MIME type and matching file signature.

Use a data delegate to enforce the 8 MiB cap while bytes arrive, including responses with no Content-Length
or an inaccurate one. Reject empty bodies and HTML/JSON error pages. Preserve the encoded bytes without
resizing or converting them. Do not persist failures or interpret 404 as proof of emoji deletion.

Bound unique active downloads explicitly; an HTTP connection limit alone does not cap HTTP/2 streams.
The loader queues additional misses, with a maximum of 256 unique queued downloads. Cancelling an unneeded
request removes it from the queue. Queue overflow returns a recoverable load failure; it never expands the
queue without a bound. The existing renderer visibility control continues to limit requests during a fling.

There is no automatic retry loop. A later load can try again after a transient failure. Foreground downloads
can be cancelled on backgrounding; no background-transfer session or new background entitlement is needed.

## Loader and WebKit interface

~~~swift
struct EmojiRequestToken: Hashable, Sendable {
    let id: UUID
}

enum EmojiLoadFailure: Error, Sendable {
    case unpaired
    case invalidAsset
    case unsupportedVersion
    case queueFull
    case cancelled
    case upstream(status: Int)
    case invalidResponse
    case tooLarge
    case transport
}

@MainActor
protocol EmojiImageLoader {
    func replacePairing(with context: EmojiPairingContext?)
    @discardableResult
    func load(
        _ key: EmojiAssetKey,
        completion: @escaping (Result<EmojiAsset, EmojiLoadFailure>) -> Void
    ) -> EmojiRequestToken
    func cancel(_ token: EmojiRequestToken)
    func remove(ids: Set<String>)
    func purgeMemory()
    func flush()
    func close()
    func stats() async -> EmojiCacheStats
}
~~~

`ShellEmojiCache` implements this facade over a worker coordinator, `EmojiStore`, and `EmojiDownloader`.
Inject the policy, store, downloader, and clock for deterministic tests.

Coalesce loads by namespace and key, including pending disk reads. Each caller receives its own token. A
cancelled token receives no later completion; another caller for the same asset remains valid. Cancel the
shared queued/download task when its last caller leaves. Return hits from memory or disk without any network
request. A successful miss can display even if persistence is unavailable.

Register the loader with `ShellAssetSchemeHandler` before WebView construction completes. Add an `emoji`
branch before any photo-library permission checks. Existing thumbnail behavior stays in its own branch.
Validate the requesting document's paired origin before accessing the loader. Emoji loads need no Photos
permission or new permission prompt.

Keep `ObjectIdentifier(WKURLSchemeTask) -> EmojiRequestToken` on the main queue. On `stop`, remove the task
and cancel its token. Completion callbacks check that the task remains live before sending its response,
bytes, and finish notification. Errors return an uncached response; successful images may use
`Cache-Control: private, max-age=31536000, immutable` for WebKit's own cache.

Pairing replacement, sign-out, and controller destruction close the previous loader context and cancel
queued/download work. Recheck the context generation before both persistence and response delivery.
Delete the old namespace after the new pairing is established, and keep the global byte cap during cleanup.
An initial unknown cookie state must never trigger namespace deletion. Resume foregrounding by refreshing
the validated cookie snapshot.

Explicit ID removal increments an invalidation revision for each affected ID. An earlier request cannot
commit a removed image after eviction. Size eviction removes stored entries without inventing catalog
membership rules; requesting an evicted image later is an ordinary cache miss.

## Diagnostics and acceptance

The loader exposes a snapshot of its counters and the store's byte accounting:

~~~swift
struct EmojiCacheStats: Sendable {
    let storage: EmojiStorageStats
    let memoryHits: Int
    let diskHits: Int
    let misses: Int
    let uniqueDownloads: Int
    let coalescedCallers: Int
    let cancellations: Int
    let failedDownloads: Int
    let bytesDownloaded: Int
    let activeDownloads: Int
    let queuedDownloads: Int
    let queueWaitSeconds: TimeInterval
}
~~~

Use signposts for lookup, queue wait, download, and commit. Diagnostics contain no pairing cookie.

Foundation tests use a temporary directory, an injected clock, and an injected downloader. Verify restart
recovery, both representations of one ID, coalescing, byte accounting, eviction order, queue/concurrency
bounds, interrupted writes, corrupt indexes/files, failed persistence, and generation/removal races.
HTTP tests cover 401/404/5xx, redirects, unexpected MIME/signatures, empty bodies, size-limit enforcement,
and cancellation. Existing JavaScript contract tests cannot replace these native tests.

On a physical iPhone, check:

1. Load still and animated emoji; restart the app; remove WebKit image caches while preserving pairing
   cookies. Retained images produce zero desktop `/media/emoji/` requests.
2. Verify the still frame and animation behavior in the picker, message text, and reactions.
3. Repeat a fast fling and a reopen. Unique downloads stay within the configured concurrency limit;
   stopped scheme tasks cause no exceptions.
4. Exercise a small test byte cap. Retained entries load locally, while evicted entries download again.
5. Deny Photos access. Emoji still load, and native photo thumbnails keep their existing permission behavior.
6. Re-pair, sign out, background, foreground, and interrupt a download. Previous contexts never commit or
   deliver into the new context.
7. Check both compatibility directions: a new page with an older app uses HTTP; a new app with an older
   page keeps working through that page's existing URLs.

Use desktop endpoint counts to prove the persistence requirement. WebKit memory hits bypass the native
handler, so native hit counters alone cannot measure every image display.

## Running the checks

`pnpm test:ios-cache` runs the app's actual Foundation sources through the dependency-free `ios/Package.swift`.
The macOS CI job runs this suite on every pull request and push to main.
The App project's shared scheme also runs those tests on iOS, plus `AppTests/ShellEmojiSchemeTests.swift`:

~~~sh
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  CODE_SIGNING_ALLOWED=NO -parallel-testing-enabled NO test
~~~

The WebKit test downloads a real WebP and a generated two-frame GIF through the native downloader, displays
them through the custom scheme, removes WebKit memory/disk caches, and reconstructs the view, loader, and
store twice. Only the first two image requests reach the HTTP fixture. Other native tests exercise response
limits, stopped scheme tasks, queued cancellation, and invalidation while a storage write is suspended.

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm shell:sync` for the shared contracts and packaging.
Physical-device checks above remain the release acceptance procedure; simulator runs do not verify real
device memory pressure, an actual process restart, or the paired desktop's endpoint counters.

Validation on 2026-10-10: 30 Foundation tests and 34 iOS simulator tests passed; the shared suite passed
2,122 tests (4 skipped). Type-checking, production build, Capacitor sync, and unsigned simulator/device-target
builds passed. The rebuilt app also launched against the existing paired page in the simulator.
No physical iPhone was connected, so the physical-device release checks have not been performed.

Deployment on 2026-10-11: the signed Debug app was installed on a test iPhone and launched successfully.
The physical-device release checks above remain outstanding. Before committing, all 30 Foundation tests
and 16 focused renderer, capability, and SDK contract tests passed again.

Catalog completeness and deletion reconciliation remain a separate phase.

This phase requires an updated desktop renderer and a rebuilt iPhone app to activate native routing. It
needs no new desktop media endpoint, new authentication kind, Photos permission, or third-party package.

## Platform references

- [Apple filesystem storage guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)
- [Apple backup exclusion guidance](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup)
- [Apple custom scheme registration](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/seturlschemehandler(_:forurlscheme:))
- [Apple scheme task completion rules](https://developer.apple.com/documentation/webkit/wkurlschemetask/didfinish())
