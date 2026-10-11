import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

final class EmojiStoreTests: XCTestCase {
    func testRestartRetainsBothRepresentationsAndExcludesBackups() async throws {
        let root = temporaryRoot(), context = pairing()
        let store = ShellEmojiStore(root: root)
        try await store.recover()
        await store.activate(namespace: context.namespace, generation: context.generation)
        for representation in [EmojiRepresentation.webp, .gif] {
            try await stored(store, emojiKey(1, representation), emojiAsset(representation), context)
        }
        let restarted = ShellEmojiStore(root: root)
        try await restarted.recover()
        for representation in [EmojiRepresentation.webp, .gif] {
            let read = try await restarted.read(emojiKey(1, representation), namespace: context.namespace)
            XCTAssertEqual(read?.data, emojiAsset(representation).data)
        }
        let stats = await restarted.stats()
        XCTAssertEqual(stats.entries, 2)
        XCTAssertEqual(stats.imageBytes, 256)
        XCTAssertGreaterThan(stats.totalStorageBytes, stats.imageBytes)
        let excluded = try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        XCTAssertEqual(excluded, true)
    }

    func testLostIndexRecoversValidOrphansAndDropsInterruptedWrites() async throws {
        let root = temporaryRoot(), context = pairing()
        let directory = root.appendingPathComponent(context.namespace)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try emojiAsset().data.write(to: directory.appendingPathComponent(emojiKey().filename))
        try Data("partial".utf8).write(to: directory.appendingPathComponent(".abandoned.tmp"))
        try Data("partial".utf8).write(to: root.appendingPathComponent(".index.tmp"))
        try Data("invalid json".utf8).write(to: root.appendingPathComponent("index.json"))
        try Data("HTML error".utf8).write(to: directory.appendingPathComponent(emojiKey(2).filename))
        let store = ShellEmojiStore(root: root)
        try await store.recover()
        let stats = await store.stats()
        XCTAssertEqual(stats.entries, 1)
        XCTAssertEqual(stats.recoveryRemovals, 3)
        let image = try await store.read(emojiKey(), namespace: context.namespace)
        XCTAssertNotNil(image)
    }

    func testChecksumMismatchAndMissingFileBecomeMisses() async throws {
        let root = temporaryRoot(), context = pairing()
        let original = ShellEmojiStore(root: root)
        try await original.recover()
        await original.activate(namespace: context.namespace, generation: context.generation)
        try await stored(original, emojiKey(1), emojiAsset(), context)
        try await stored(original, emojiKey(2), emojiAsset(), context)
        var corrupted = emojiAsset().data
        corrupted[20] = 99
        try corrupted.write(to: root.appendingPathComponent("\(context.namespace)/\(emojiKey(1).filename)"))
        try FileManager.default.removeItem(at: root.appendingPathComponent("\(context.namespace)/\(emojiKey(2).filename)"))
        let restarted = ShellEmojiStore(root: root)
        try await restarted.recover()
        let stats = await restarted.stats()
        XCTAssertEqual(stats.entries, 0)
        XCTAssertEqual(stats.recoveryRemovals, 2)
    }

    func testReadCorruptionIsRemovedWithoutServingIt() async throws {
        let root = temporaryRoot(), context = pairing()
        let actual = ShellEmojiStore(root: root)
        try await actual.recover()
        await actual.activate(namespace: context.namespace, generation: context.generation)
        try await stored(actual, emojiKey(), emojiAsset(), context)
        try Data("invalid".utf8).write(to: root.appendingPathComponent("\(context.namespace)/\(emojiKey().filename)"))
        let image = try await actual.read(emojiKey(), namespace: context.namespace)
        XCTAssertNil(image)
        let stats = await actual.stats()
        XCTAssertEqual(stats.entries, 0)
    }

    func testByteCapIncludesIndexAndEvictsLeastRecentlyRead() async throws {
        let clock = TestClock(), context = pairing(), root = temporaryRoot()
        var policy = EmojiCachePolicy(); policy.diskBytesMax = 12_000
        let store = ShellEmojiStore(root: root, policy: policy, clock: { clock.now() })
        try await store.recover()
        await store.activate(namespace: context.namespace, generation: context.generation)
        for number in 1...3 {
            clock.advance()
            try await stored(store, emojiKey(number), emojiAsset(bytes: 3_000), context)
        }
        clock.advance()
        _ = try await store.read(emojiKey(1), namespace: context.namespace)
        clock.advance()
        try await stored(store, emojiKey(4), emojiAsset(bytes: 3_000), context)
        let oldest = try await store.read(emojiKey(2), namespace: context.namespace)
        let recentlyRead = try await store.read(emojiKey(1), namespace: context.namespace)
        XCTAssertNil(oldest)
        XCTAssertNotNil(recentlyRead)
        let stats = await store.stats()
        XCTAssertLessThanOrEqual(stats.totalStorageBytes, policy.diskBytesMax)
        XCTAssertGreaterThan(stats.sizeEvictions, 0)
        try await store.trim(to: 0)
        let trimmed = await store.stats()
        XCTAssertEqual(trimmed.totalStorageBytes, 0)
    }

    func testRemovalInvalidatesPendingWritesAndBothRepresentations() async throws {
        let context = pairing(), store = ShellEmojiStore(root: temporaryRoot())
        try await store.recover()
        await store.activate(namespace: context.namespace, generation: context.generation)
        let permit = await store.beginLoad(emojiKey(), namespace: context.namespace, generation: context.generation)!
        for representation in [EmojiRepresentation.webp, .gif] { try await stored(store, emojiKey(1, representation), emojiAsset(representation), context) }
        try await store.remove(ids: [emojiKey().id], namespace: context.namespace)
        do { try await store.write(emojiAsset(), permit: permit); XCTFail("Stale write accepted") }
        catch ShellEmojiStore.StoreError.stalePermit { }
        let stats = await store.stats()
        XCTAssertEqual(stats.entries, 0)
        // A later deliberate request gets a fresh permit and can store the image again.
        try await stored(store, emojiKey(), emojiAsset(), context)
    }

    func testDeactivationAndNamespaceClearingInvalidatePermits() async throws {
        let context = pairing(), store = ShellEmojiStore(root: temporaryRoot())
        try await store.recover()
        await store.activate(namespace: context.namespace, generation: context.generation)
        let permit = await store.beginLoad(emojiKey(), namespace: context.namespace, generation: context.generation)!
        await store.deactivate(generation: context.generation)
        do { try await store.write(emojiAsset(), permit: permit); XCTFail("Inactive write accepted") }
        catch ShellEmojiStore.StoreError.stalePermit { }
        await store.activate(namespace: context.namespace, generation: context.generation)
        let newer = await store.beginLoad(emojiKey(), namespace: context.namespace, generation: context.generation)!
        try await store.clear(namespace: context.namespace)
        do { try await store.write(emojiAsset(), permit: newer); XCTFail("Cleared write accepted") }
        catch ShellEmojiStore.StoreError.stalePermit { }
    }

    func testRePairingDeletesPreviousNamespace() async throws {
        let old = pairing(), new = pairing("new-token"), root = temporaryRoot()
        let store = ShellEmojiStore(root: root)
        try await store.recover()
        await store.activate(namespace: old.namespace, generation: old.generation)
        try await stored(store, emojiKey(), emojiAsset(), old)
        let restarted = ShellEmojiStore(root: root)
        try await restarted.recover()
        await restarted.activate(namespace: new.namespace, generation: new.generation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(old.namespace).path))
        let stats = await restarted.stats()
        XCTAssertEqual(stats.entries, 0)
    }

    func testOversizedAndUnwritableStorageFailWithoutLeavingStagingFiles() async throws {
        let context = pairing(), root = temporaryRoot()
        var policy = EmojiCachePolicy(); policy.diskBytesMax = 1_000
        let store = ShellEmojiStore(root: root, policy: policy)
        try await store.recover()
        await store.activate(namespace: context.namespace, generation: context.generation)
        do { try await stored(store, emojiKey(), emojiAsset(bytes: 2_000), context); XCTFail("Capacity exceeded") }
        catch ShellEmojiStore.StoreError.capacity { }
        let stats = await store.stats()
        XCTAssertLessThanOrEqual(stats.totalStorageBytes, 1_000)
        XCTAssertEqual(stats.writeFailures, 1)
        let blocked = temporaryRoot()
        try Data().write(to: blocked)
        let unavailable = ShellEmojiStore(root: blocked)
        do { try await unavailable.recover(); XCTFail("File used as directory") } catch { }
        do { try await unavailable.recover(); XCTFail("Failed recovery retried") }
        catch ShellEmojiStore.StoreError.unavailable { }
    }
}
