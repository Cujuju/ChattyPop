import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

func emojiKey(_ number: Int = 1, _ representation: EmojiRepresentation = .webp) -> EmojiAssetKey {
    EmojiAssetKey(id: String(123456789012345 + number), representation: representation)!
}
func emojiAsset(_ representation: EmojiRepresentation = .webp, bytes: Int = 128) -> EmojiAsset {
    var data = representation == .webp ? Data("RIFF0000WEBP".utf8) : Data("GIF89a0000".utf8)
    data.append(Data(repeating: 42, count: max(0, bytes - data.count)))
    return EmojiAsset(data: data, contentType: representation.contentType)
}
func pairing(_ token: String = "test-token") -> EmojiPairingContext {
    EmojiPairingContext(origin: URL(string: "https://desktop.ts.net")!, token: token)!
}
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var time = Date(timeIntervalSince1970: 1_000)
    func now() -> Date { lock.withLock { time } }
    func advance() { lock.withLock { time.addTimeInterval(1) } }
}
extension XCTestCase {
    func temporaryRoot() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("emoji-tests-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func eventually(_ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Condition did not become true", file: file, line: line)
    }
}
@MainActor
func loaded(_ cache: ShellEmojiCache, _ key: EmojiAssetKey = emojiKey()) async throws -> EmojiAsset {
    try await withCheckedThrowingContinuation { continuation in
        var answered = false
        let token = cache.load(key) { result in
            guard !answered else { return }
            answered = true
            continuation.resume(with: result.mapError { $0 as Error })
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !answered else { return }
            answered = true
            cache.cancel(token)
            XCTFail("Image request did not complete")
            continuation.resume(throwing: EmojiLoadFailure.transport)
        }
    }
}
func stored(_ store: ShellEmojiStore, _ key: EmojiAssetKey, _ asset: EmojiAsset, _ context: EmojiPairingContext) async throws {
    let permit = await store.beginLoad(key, namespace: context.namespace, generation: context.generation)!
    try await store.write(asset, permit: permit)
}

actor ControlledDownloader: EmojiDownloader {
    private var pending: [UUID: (EmojiAssetKey, CheckedContinuation<EmojiAsset, Error>)] = [:]
    private var cancelled = Set<UUID>()
    private(set) var calls = 0
    private(set) var maximumActive = 0
    var active: Int { pending.count }
    var activeKeys: [EmojiAssetKey] { pending.values.map { $0.0 } }
    func download(_ key: EmojiAssetKey, context: EmojiPairingContext, policy: EmojiCachePolicy) async throws -> EmojiAsset {
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                if cancelled.remove(id) != nil { continuation.resume(throwing: EmojiLoadFailure.cancelled); return }
                calls += 1
                pending[id] = (key, continuation)
                maximumActive = max(maximumActive, pending.count)
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    private func cancel(_ id: UUID) {
        if let request = pending.removeValue(forKey: id) { request.1.resume(throwing: EmojiLoadFailure.cancelled) }
        else { cancelled.insert(id) }
    }
    func complete(_ key: EmojiAssetKey, failure: EmojiLoadFailure? = nil, bytes: Int = 128) {
        guard let id = pending.first(where: { $0.value.0 == key })?.key, let request = pending.removeValue(forKey: id) else { return }
        if let failure { request.1.resume(throwing: failure) }
        else { request.1.resume(returning: emojiAsset(key.representation, bytes: bytes)) }
    }
}

/// Pause a real store write across an await to exercise invalidation while a commit is pending.
actor WriteBarrierStore: EmojiStore {
    let underlying: ShellEmojiStore
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var writing = false
    init(root: URL) { underlying = ShellEmojiStore(root: root) }
    func recover() async throws { try await underlying.recover() }
    func activate(namespace: String, generation: UUID) async { await underlying.activate(namespace: namespace, generation: generation) }
    func deactivate(generation: UUID) async { await underlying.deactivate(generation: generation) }
    func beginLoad(_ key: EmojiAssetKey, namespace: String, generation: UUID) async -> EmojiWritePermit? { await underlying.beginLoad(key, namespace: namespace, generation: generation) }
    func read(_ key: EmojiAssetKey, namespace: String) async throws -> EmojiAsset? { try await underlying.read(key, namespace: namespace) }
    func touch(_ key: EmojiAssetKey, namespace: String) async { await underlying.touch(key, namespace: namespace) }
    func write(_ asset: EmojiAsset, permit: EmojiWritePermit) async throws {
        writing = true
        await withCheckedContinuation { continuation = $0 }
        try await underlying.write(asset, permit: permit)
    }
    func release() { continuation?.resume(); continuation = nil }
    func remove(ids: Set<String>, namespace: String) async throws { try await underlying.remove(ids: ids, namespace: namespace) }
    func trim(to maximumBytes: Int) async throws { try await underlying.trim(to: maximumBytes) }
    func clear(namespace: String) async throws { try await underlying.clear(namespace: namespace) }
    func flush() async throws { try await underlying.flush() }
    func stats() async -> EmojiStorageStats { await underlying.stats() }
}
