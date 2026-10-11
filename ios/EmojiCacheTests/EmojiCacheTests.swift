import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

@MainActor
final class EmojiCacheTests: XCTestCase {
    private func makeCache(_ downloader: ControlledDownloader, root: URL? = nil, policy: EmojiCachePolicy = EmojiCachePolicy()) -> ShellEmojiCache {
        ShellEmojiCache(store: ShellEmojiStore(root: root ?? temporaryRoot(), policy: policy), downloader: downloader, policy: policy)
    }

    func testInitialRequestsWaitForPairingInsteadOfFailing() async throws {
        let downloader = ControlledDownloader()
        let waiting = makeCache(downloader)
        let request = Task { try await loaded(waiting) }
        for _ in 0..<20 { await Task.yield() }
        let before = await downloader.calls
        XCTAssertEqual(before, 0)
        waiting.replacePairing(with: pairing())
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        _ = try await request.value
        waiting.close()
    }

    func testCoalescedCallerCancellationLeavesOtherCallerAlive() async throws {
        let downloader = ControlledDownloader(), cache = makeCache(downloader)
        cache.replacePairing(with: pairing())
        var stoppedCalled = false
        let token = cache.load(emojiKey()) { _ in stoppedCalled = true }
        let other = Task { try await loaded(cache) }
        await eventually { (await cache.stats()).coalescedCallers == 1 }
        cache.cancel(token)
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        _ = try await other.value
        XCTAssertFalse(stoppedCalled)
        let stats = await cache.stats()
        XCTAssertEqual(stats.uniqueDownloads, 1)
        XCTAssertEqual(stats.cancellations, 1)
        cache.close()
    }

    func testRestartAndMemoryPurgeUseDiskWithNoDownloads() async throws {
        let downloader = ControlledDownloader(), root = temporaryRoot(), context = pairing()
        let first = makeCache(downloader, root: root)
        first.replacePairing(with: context)
        let request = Task { try await loaded(first) }
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        let image = try await request.value
        _ = try await loaded(first)
        first.purgeMemory()
        _ = try await loaded(first)
        first.close()
        let second = makeCache(downloader, root: root)
        second.replacePairing(with: pairing())
        let retained = try await loaded(second)
        XCTAssertEqual(image.data, retained.data)
        let calls = await downloader.calls
        XCTAssertEqual(calls, 1)
        let stats = await second.stats()
        XCTAssertEqual(stats.diskHits, 1)
        second.close()
    }

    func testConcurrentAndQueueLimitsAndQueuedCancellation() async throws {
        let downloader = ControlledDownloader()
        var policy = EmojiCachePolicy(); policy.downloadsMax = 1; policy.queuedDownloadsMax = 1
        let cache = makeCache(downloader, policy: policy)
        cache.replacePairing(with: pairing())
        let first = Task { try await loaded(cache, emojiKey(1)) }
        await eventually { await downloader.calls == 1 }
        var cancelledCallback = false
        let queued = cache.load(emojiKey(2)) { _ in cancelledCallback = true }
        await eventually { (await cache.stats()).queuedDownloads == 1 }
        do { _ = try await loaded(cache, emojiKey(3)); XCTFail("Unbounded queue") }
        catch EmojiLoadFailure.queueFull { }
        cache.cancel(queued)
        await downloader.complete(emojiKey(1))
        _ = try await first.value
        let calls = await downloader.calls
        let maximum = await downloader.maximumActive
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(maximum, 1)
        XCTAssertFalse(cancelledCallback)
        cache.close()
    }

    func testQueueDrainsAndLastCallerCancelsSharedDownload() async throws {
        let downloader = ControlledDownloader()
        var policy = EmojiCachePolicy(); policy.downloadsMax = 1
        let cache = makeCache(downloader, policy: policy)
        cache.replacePairing(with: pairing())
        let token = cache.load(emojiKey(1)) { _ in XCTFail("Stopped token answered") }
        await eventually { await downloader.active == 1 }
        let second = Task { try await loaded(cache, emojiKey(2)) }
        await eventually { (await cache.stats()).queuedDownloads == 1 }
        cache.cancel(token)
        await eventually { await downloader.calls == 2 }
        await downloader.complete(emojiKey(2))
        _ = try await second.value
        let maximum = await downloader.maximumActive
        XCTAssertEqual(maximum, 1)
        cache.close()
    }

    func testFailedDownloadsAreNotCachedAndLaterLoadsRetry() async throws {
        let downloader = ControlledDownloader(), cache = makeCache(downloader)
        cache.replacePairing(with: pairing())
        let first = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey(), failure: .upstream(status: 404))
        do { _ = try await first.value; XCTFail("Failure served as image") }
        catch EmojiLoadFailure.upstream(status: 404) { }
        let second = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 2 }
        await downloader.complete(emojiKey())
        _ = try await second.value
        cache.close()
    }

    func testPersistenceFailureStillDisplaysDownloadedBytes() async throws {
        let downloader = ControlledDownloader(), root = temporaryRoot()
        try Data().write(to: root)
        let cache = makeCache(downloader, root: root)
        cache.replacePairing(with: pairing())
        let request = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        let image = try await request.value
        XCTAssertEqual(image.data, emojiAsset().data)
        cache.close()
    }

    func testPairingReplacementAndSignOutRejectOldLoads() async throws {
        let downloader = ControlledDownloader(), cache = makeCache(downloader)
        cache.replacePairing(with: pairing())
        let old = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 1 }
        cache.replacePairing(with: pairing("replacement"))
        do { _ = try await old.value; XCTFail("Old pairing delivered") }
        catch EmojiLoadFailure.cancelled { }
        let new = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 2 }
        await downloader.complete(emojiKey())
        _ = try await new.value
        cache.replacePairing(with: nil)
        do { _ = try await loaded(cache); XCTFail("Signed out load accepted") }
        catch EmojiLoadFailure.unpaired { }
        cache.close()
    }

    func testMemoryCostLimitAndRemovalInvalidateAllVariants() async throws {
        let downloader = ControlledDownloader()
        var policy = EmojiCachePolicy(); policy.memoryBytesMax = 200
        let cache = makeCache(downloader, policy: policy)
        cache.replacePairing(with: pairing())
        for representation in [EmojiRepresentation.webp, .gif] {
            let request = Task { try await loaded(cache, emojiKey(1, representation)) }
            await eventually { await downloader.active == 1 }
            await downloader.complete(emojiKey(1, representation))
            _ = try await request.value
        }
        _ = try await loaded(cache)
        let stats = await cache.stats()
        XCTAssertEqual(stats.diskHits, 1) // the 128-byte GIF evicted the 128-byte WebP from memory
        cache.remove(ids: [emojiKey().id])
        let request = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 3 }
        await downloader.complete(emojiKey())
        _ = try await request.value
        cache.close()
    }

    func testBackgroundAndCloseCancelWorkAndKeepRetainedFiles() async throws {
        let downloader = ControlledDownloader(), cache = makeCache(downloader)
        cache.replacePairing(with: pairing())
        let request = Task { try await loaded(cache) }
        await eventually { await downloader.active == 1 }
        cache.suspend()
        do { _ = try await request.value; XCTFail("Background work delivered") }
        catch EmojiLoadFailure.cancelled { }
        await eventually { await downloader.active == 0 }
        cache.close()
        do { _ = try await loaded(cache); XCTFail("Closed cache accepted work") }
        catch EmojiLoadFailure.unpaired { }
    }

    func testRemovalWhileStoreWriteWaitsRejectsStaleCommit() async throws {
        let store = WriteBarrierStore(root: temporaryRoot()), downloader = ControlledDownloader(), context = pairing()
        let cache = ShellEmojiCache(store: store, downloader: downloader)
        cache.replacePairing(with: context)
        let request = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        await eventually { await store.writing }
        cache.remove(ids: [emojiKey().id])
        do { _ = try await request.value; XCTFail("Removed image delivered") }
        catch EmojiLoadFailure.cancelled { }
        await eventually {
            let permit = await store.beginLoad(emojiKey(), namespace: context.namespace, generation: context.generation)
            return (permit?.revision ?? 0) > 0
        }
        await store.release()
        await eventually { (await cache.stats()).activeDownloads == 0 }
        let stats = await store.stats()
        XCTAssertEqual(stats.entries, 0)
        cache.close()
    }

    func testPairingChangeWhileStoreWriteWaitsRejectsStaleCommit() async throws {
        let store = WriteBarrierStore(root: temporaryRoot()), downloader = ControlledDownloader(), old = pairing()
        let cache = ShellEmojiCache(store: store, downloader: downloader)
        cache.replacePairing(with: old)
        let request = Task { try await loaded(cache) }
        await eventually { await downloader.calls == 1 }
        await downloader.complete(emojiKey())
        await eventually { await store.writing }
        cache.replacePairing(with: pairing("replacement"))
        do { _ = try await request.value; XCTFail("Old generation delivered") }
        catch EmojiLoadFailure.cancelled { }
        await eventually { await store.beginLoad(emojiKey(), namespace: old.namespace, generation: old.generation) == nil }
        await store.release()
        await eventually { (await cache.stats()).activeDownloads == 0 }
        let stats = await store.stats()
        XCTAssertEqual(stats.entries, 0)
        cache.close()
    }

    func testDefaultConcurrencyBoundsBurstOfUniqueLoads() async throws {
        let downloader = ControlledDownloader(), cache = makeCache(downloader)
        cache.replacePairing(with: pairing())
        let requests = (1...40).map { number in Task { try await loaded(cache, emojiKey(number)) } }
        await eventually { (await cache.stats()).queuedDownloads == 36 }
        for _ in 0..<10 {
            await eventually { await downloader.active == 4 }
            let keys = await downloader.activeKeys
            for key in keys { await downloader.complete(key) }
        }
        for request in requests { _ = try await request.value }
        let maximum = await downloader.maximumActive
        XCTAssertEqual(maximum, 4)
        let stats = await cache.stats()
        XCTAssertEqual(stats.uniqueDownloads, 40)
        XCTAssertEqual(stats.queuedDownloads, 0)
        cache.close()
    }
}
