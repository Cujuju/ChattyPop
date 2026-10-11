import Foundation
import OSLog

/// Main-thread facade; disk work is actor-isolated and HTTP work runs on the session's delegate queue.
@MainActor
final class ShellEmojiCache: EmojiImageLoader {
    private static let signposter = OSSignposter(subsystem: "com.cujuju.chattypop", category: "EmojiCache")
    private final class Load {
        let id = UUID()
        let key: EmojiAssetKey
        var context: EmojiPairingContext?
        var callers: [EmojiRequestToken: (Result<EmojiAsset, EmojiLoadFailure>) -> Void] = [:]
        var task: Task<Void, Never>?
        var permit: EmojiWritePermit?
        var queuedAt: Date?
        init(key: EmojiAssetKey) { self.key = key }
    }
    private struct MemoryEntry { let asset: EmojiAsset; var access: UInt64 }
    private let store: any EmojiStore
    private let downloader: any EmojiDownloader
    private let policy: EmojiCachePolicy
    private let clock: @Sendable () -> Date
    private var context: EmojiPairingContext?
    private var pairingReady = false
    private var closed = false
    private var preparation: Task<Void, Never>?
    private var loads: [UUID: Load] = [:]
    private var keys: [EmojiAssetKey: UUID] = [:]
    private var tokens: [EmojiRequestToken: UUID] = [:]
    private var queue: [UUID] = []
    private var active = Set<UUID>()
    private var memory: [EmojiAssetKey: MemoryEntry] = [:]
    private var memoryBytes = 0
    private var access: UInt64 = 0
    private var counters = EmojiCacheStats()

    init(store: any EmojiStore, downloader: any EmojiDownloader, policy: EmojiCachePolicy = EmojiCachePolicy(), clock: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.downloader = downloader
        self.policy = policy
        self.clock = clock
    }

    func replacePairing(with next: EmojiPairingContext?) {
        guard !closed, !pairingReady || context != next else { return }
        let wasReady = pairingReady
        let previous = context
        context = next
        pairingReady = true
        purgeMemory()
        if wasReady {
            for load in Array(loads.values) {
                load.task?.cancel()
                finish(load, .failure(.cancelled))
            }
        }
        let preceding = preparation
        preparation = Task { [weak self, store] in
            await preceding?.value
            if let previous { await store.deactivate(generation: previous.generation) }
            try? await store.recover()
            guard let self, !self.closed, self.context == next else { return }
            if let next { await store.activate(namespace: next.namespace, generation: next.generation) }
            else if let previous { try? await store.clear(namespace: previous.namespace) }
        }
        if !wasReady { for load in Array(loads.values) { startLookup(load) } }
    }

    @discardableResult
    func load(_ key: EmojiAssetKey, completion: @escaping (Result<EmojiAsset, EmojiLoadFailure>) -> Void) -> EmojiRequestToken {
        let token = EmojiRequestToken()
        if let id = keys[key], let existing = loads[id] {
            existing.callers[token] = completion
            tokens[token] = id
            counters.coalescedCallers += 1
            return token
        }
        let load = Load(key: key)
        load.callers[token] = completion
        loads[load.id] = load
        tokens[token] = load.id
        // All completions are asynchronous, including immediate failures and memory hits.
        if closed || (pairingReady && context == nil) {
            load.task = Task { [weak self] in self?.finish(load, .failure(.unpaired)) }
        } else if loads.count > max(0, policy.queuedDownloadsMax) + max(1, policy.downloadsMax) {
            load.task = Task { [weak self] in self?.finish(load, .failure(.queueFull)) }
        } else {
            keys[key] = load.id
            if pairingReady { startLookup(load) }
        }
        return token
    }

    func cancel(_ token: EmojiRequestToken) {
        guard let id = tokens.removeValue(forKey: token), let load = loads[id] else { return }
        counters.cancellations += 1
        load.callers.removeValue(forKey: token)
        if load.callers.isEmpty {
            load.task?.cancel()
            discard(load)
            drain()
        }
    }

    func remove(ids: Set<String>) {
        guard let context else { return }
        for key in Array(memory.keys) where ids.contains(key.id) {
            memoryBytes -= memory.removeValue(forKey: key)?.asset.data.count ?? 0
        }
        for load in Array(loads.values) where ids.contains(load.key.id) {
            load.task?.cancel()
            finish(load, .failure(.cancelled))
        }
        // Subsequent lookups await this invalidation, so they cannot read the old disk entry.
        let preceding = preparation
        preparation = Task { [store] in
            await preceding?.value
            try? await store.remove(ids: ids, namespace: context.namespace)
        }
    }

    func purgeMemory() { memory.removeAll(); memoryBytes = 0 }
    func flush() { Task { [store] in try? await store.flush() } }

    /// Backgrounding stops foreground work while retaining the validated pairing and durable files.
    func suspend() {
        for load in Array(loads.values) {
            load.task?.cancel()
            finish(load, .failure(.cancelled))
        }
        purgeMemory()
        flush()
    }

    func close() {
        guard !closed else { return }
        closed = true
        suspend()
        let previous = context
        context = nil
        let preceding = preparation
        preparation = Task { [store] in
            await preceding?.value
            if let previous { await store.deactivate(generation: previous.generation) }
            try? await store.flush()
        }
    }

    func stats() async -> EmojiCacheStats {
        var result = counters
        result.storage = await store.stats()
        result.activeDownloads = active.count
        result.queuedDownloads = queue.count
        return result
    }

    private func startLookup(_ load: Load) {
        load.context = context
        let ready = preparation
        load.task = Task { [weak self] in
            guard let self else { return }
            let interval = Self.signposter.beginInterval("lookup")
            defer { Self.signposter.endInterval("lookup", interval) }
            await ready?.value
            guard self.isLive(load), let context = load.context else { return self.finish(load, .failure(.unpaired)) }
            if var entry = self.memory[load.key] {
                self.access &+= 1
                entry.access = self.access
                self.memory[load.key] = entry
                self.counters.memoryHits += 1
                await self.store.touch(load.key, namespace: context.namespace)
                guard self.isLive(load) else { return }
                return self.finish(load, .success(entry.asset))
            }
            load.permit = await self.store.beginLoad(load.key, namespace: context.namespace, generation: context.generation)
            guard self.isLive(load) else { return }
            if let asset = try? await self.store.read(load.key, namespace: context.namespace) {
                guard self.isLive(load) else { return }
                self.counters.diskHits += 1
                self.keep(asset, key: load.key)
                return self.finish(load, .success(asset))
            }
            guard self.isLive(load) else { return }
            self.counters.misses += 1
            if self.active.count >= max(1, self.policy.downloadsMax) && self.queue.count >= max(0, self.policy.queuedDownloadsMax) {
                return self.finish(load, .failure(.queueFull))
            }
            load.queuedAt = self.clock()
            self.queue.append(load.id)
            self.drain()
        }
    }

    private func drain() {
        while active.count < max(1, policy.downloadsMax), !queue.isEmpty {
            let id = queue.removeFirst()
            guard let load = loads[id], let context = load.context, isLive(load) else { continue }
            active.insert(id)
            counters.uniqueDownloads += 1
            let waited = max(0, clock().timeIntervalSince(load.queuedAt ?? clock()))
            counters.queueWaitSeconds += waited
            Self.signposter.emitEvent("queueWait", "seconds \(waited)")
            load.task = Task { [weak self, downloader, policy] in
                guard let self else { return }
                defer { self.active.remove(id); self.drain() }
                do {
                    try Task.checkCancellation()
                    let asset = try await downloader.download(load.key, context: context, policy: policy)
                    guard self.isLive(load) else { return }
                    self.counters.bytesDownloaded += asset.data.count
                    if let permit = load.permit { try? await self.store.write(asset, permit: permit) }
                    guard self.isLive(load) else { return }
                    self.keep(asset, key: load.key)
                    self.finish(load, .success(asset))
                } catch {
                    guard self.loads[id] != nil else { return }
                    self.counters.failedDownloads += 1
                    self.finish(load, .failure(error as? EmojiLoadFailure ?? (Task.isCancelled ? .cancelled : .transport)))
                }
            }
        }
    }

    private func isLive(_ load: Load) -> Bool {
        // A cancelled download drains the queue in its defer. The current Task's cancellation
        // belongs to that download, not to the other queued callers.
        !closed && loads[load.id] != nil && !load.callers.isEmpty && load.context == context
    }
    private func finish(_ load: Load, _ result: Result<EmojiAsset, EmojiLoadFailure>) {
        guard loads[load.id] != nil else { return }
        let callbacks = Array(load.callers.values)
        discard(load)
        for callback in callbacks { callback(result) }
    }
    private func discard(_ load: Load) {
        loads.removeValue(forKey: load.id)
        if keys[load.key] == load.id { keys.removeValue(forKey: load.key) }
        for token in load.callers.keys { tokens.removeValue(forKey: token) }
        queue.removeAll { $0 == load.id }
    }
    private func keep(_ asset: EmojiAsset, key: EmojiAssetKey) {
        guard asset.data.count <= policy.memoryBytesMax else { return }
        memoryBytes -= memory.removeValue(forKey: key)?.asset.data.count ?? 0
        while memoryBytes + asset.data.count > policy.memoryBytesMax, let oldest = memory.min(by: { $0.value.access < $1.value.access })?.key {
            memoryBytes -= memory.removeValue(forKey: oldest)?.asset.data.count ?? 0
        }
        access &+= 1
        memory[key] = MemoryEntry(asset: asset, access: access)
        memoryBytes += asset.data.count
    }
}
