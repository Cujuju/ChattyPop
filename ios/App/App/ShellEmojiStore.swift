import Darwin
import Foundation
import OSLog

/// All filesystem operations and invalidation checks run on this actor, away from the UI thread.
actor ShellEmojiStore: EmojiStore {
    private struct Entry: Codable {
        let namespace: String
        let key: EmojiAssetKey
        let bytes: Int
        let checksum: String
        var accessed: Date
        var path: String { "\(namespace)/\(key.filename)" }
    }
    private struct Index: Codable { let version: Int; let entries: [Entry] }
    enum StoreError: Error { case unavailable, invalidAsset, stalePermit, capacity }
    private static let signposter = OSSignposter(subsystem: "com.cujuju.chattypop", category: "EmojiStore")
    private let root: URL
    private let policy: EmojiCachePolicy
    private let clock: @Sendable () -> Date
    private let files = FileManager.default
    private var entries: [String: Entry] = [:]
    private var counters = EmojiStorageStats()
    private var recovered = false
    private var recoveryFailed = false
    private var active: (namespace: String, generation: UUID)?
    private var revision: UInt64 = 0
    private var revisions: [String: UInt64] = [:]
    private var namespaceRevisions: [String: UInt64] = [:]
    private var dirty = false
    private var limit: Int

    static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.cujuju.chattypop/emoji/v1", isDirectory: true)
    }

    init(root: URL = ShellEmojiStore.defaultRoot, policy: EmojiCachePolicy = EmojiCachePolicy(), clock: @escaping @Sendable () -> Date = { Date() }) {
        self.root = root
        self.policy = policy
        self.clock = clock
        self.limit = max(0, policy.diskBytesMax)
    }

    func recover() throws {
        if recovered { return }
        if recoveryFailed { throw StoreError.unavailable }
        do {
            try files.createDirectory(at: root, withIntermediateDirectories: true)
            try excludeFromBackup(root)
            let index = try? JSONDecoder().decode(Index.self, from: Data(contentsOf: indexURL))
            let indexed = index?.version == 1 ? index?.entries ?? [] : []
            var examined = Set<String>()
            for entry in indexed {
                guard validNamespace(entry.namespace), validKey(entry.key), examined.insert(entry.path).inserted else { continue }
                let url = root.appendingPathComponent(entry.path)
                if let asset = try? readFile(url, key: entry.key), asset.data.count == entry.bytes,
                   emojiDigest(asset.data) == entry.checksum {
                    entries[entry.path] = entry
                } else {
                    try removeFile(url)
                    counters.recoveryRemovals += 1
                }
            }
            // Only regular, bounded, validated files can be recovered from a lost index.
            for directory in try files.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
                if directory.lastPathComponent == "index.json" { continue }
                let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard validNamespace(directory.lastPathComponent), values.isDirectory == true, values.isSymbolicLink != true else {
                    try removeFile(directory); counters.recoveryRemovals += 1; continue
                }
                try excludeFromBackup(directory)
                for url in try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) {
                    let path = "\(directory.lastPathComponent)/\(url.lastPathComponent)"
                    if entries[path] != nil { continue }
                    let assetURL = URL(string: "chattypop-asset://emoji/v1/\(url.lastPathComponent)")
                    guard !examined.contains(path), let assetURL, let key = EmojiAssetKey(assetURL: assetURL),
                          let asset = try? readFile(url, key: key) else {
                        try removeFile(url); counters.recoveryRemovals += 1; continue
                    }
                    try excludeFromBackup(url)
                    let modified = try url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? clock()
                    entries[path] = Entry(namespace: directory.lastPathComponent, key: key, bytes: asset.data.count,
                                          checksum: emojiDigest(asset.data), accessed: modified)
                }
            }
            dirty = true
            try persistIndex()
            recovered = true
        } catch {
            recoveryFailed = true
            throw error
        }
    }

    func activate(namespace: String, generation: UUID) {
        guard validNamespace(namespace) else { return }
        active = (namespace, generation)
        // A validated new pairing is established. Remove old pairings, including those from a previous process.
        let old = Set(entries.values.map(\.namespace)).subtracting([namespace])
        for previous in old { try? clear(namespace: previous) }
    }

    func deactivate(generation: UUID) {
        if active?.generation == generation { active = nil }
    }

    func beginLoad(_ key: EmojiAssetKey, namespace: String, generation: UUID) -> EmojiWritePermit? {
        guard active?.namespace == namespace, active?.generation == generation, validKey(key) else { return nil }
        return EmojiWritePermit(key: key, namespace: namespace, generation: generation, revision: currentRevision(key.id, namespace))
    }

    func read(_ key: EmojiAssetKey, namespace: String) throws -> EmojiAsset? {
        try recover()
        guard validNamespace(namespace), validKey(key) else { throw StoreError.invalidAsset }
        let path = "\(namespace)/\(key.filename)"
        guard var entry = entries[path] else { return nil }
        do {
            let asset = try readFile(root.appendingPathComponent(path), key: key)
            guard asset.data.count == entry.bytes, emojiDigest(asset.data) == entry.checksum else { throw StoreError.invalidAsset }
            entry.accessed = clock()
            entries[path] = entry
            dirty = true
            return asset
        } catch {
            try deleteEntry(path)
            dirty = true
            return nil
        }
    }

    func write(_ asset: EmojiAsset, permit: EmojiWritePermit) throws {
        let interval = Self.signposter.beginInterval("commit")
        defer { Self.signposter.endInterval("commit", interval) }
        do {
            try recover()
            guard active?.namespace == permit.namespace, active?.generation == permit.generation,
                  currentRevision(permit.key.id, permit.namespace) == permit.revision else { throw StoreError.stalePermit }
            guard validKey(permit.key), asset.data.count <= policy.assetBytesMax,
                  asset.contentType == permit.key.representation.contentType, permit.key.representation.validates(asset.data) else { throw StoreError.invalidAsset }
            let path = "\(permit.namespace)/\(permit.key.filename)"
            // Replacement can be retried after a failed commit, and does not need two copies of the old image.
            try deleteEntry(path)
            let entry = Entry(namespace: permit.namespace, key: permit.key, bytes: asset.data.count,
                              checksum: emojiDigest(asset.data), accessed: clock())
            var projected = entries
            projected[path] = entry
            var nextIndex = try encode(projected)
            // At peak: existing images + incoming staging file + old index + new index staging file.
            while imageBytes + asset.data.count + fileSize(indexURL) + nextIndex.count > limit {
                guard let oldest = oldestPath() else { throw StoreError.capacity }
                try deleteEntry(oldest)
                counters.sizeEvictions += 1
                projected = entries; projected[path] = entry
                nextIndex = try encode(projected)
            }
            let directory = root.appendingPathComponent(permit.namespace, isDirectory: true)
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            try excludeFromBackup(directory)
            try atomicWrite(asset.data, to: directory.appendingPathComponent(permit.key.filename))
            entries[path] = entry
            dirty = true
            try atomicWrite(nextIndex, to: indexURL)
            dirty = false
        } catch {
            if case StoreError.stalePermit = error { throw error }
            counters.writeFailures += 1
            // Keep accounting valid even if a write or index replacement failed after evictions.
            try? persistIndex()
            throw error
        }
    }

    /// A memory hit still counts as use for durable LRU, without reading the file again.
    func touch(_ key: EmojiAssetKey, namespace: String) {
        let path = "\(namespace)/\(key.filename)"
        guard var entry = entries[path] else { return }
        entry.accessed = clock()
        entries[path] = entry
        dirty = true
    }

    func remove(ids: Set<String>, namespace: String) throws {
        guard validNamespace(namespace) else { return }
        revision &+= 1
        for id in ids { revisions["\(namespace)/\(id)"] = revision }
        for (path, entry) in entries where entry.namespace == namespace && ids.contains(entry.key.id) { try deleteEntry(path) }
        dirty = true
        try persistIndex()
    }

    func trim(to maximumBytes: Int) throws {
        try recover()
        limit = max(0, min(maximumBytes, policy.diskBytesMax))
        dirty = true
        try persistIndex()
    }

    func clear(namespace: String) throws {
        guard validNamespace(namespace) else { return }
        revision &+= 1
        namespaceRevisions[namespace] = revision
        // Remove the directory first; failed deletion keeps entries and their bytes accounted for.
        try removeFile(root.appendingPathComponent(namespace))
        entries = entries.filter { $0.value.namespace != namespace }
        dirty = true
        try persistIndex()
    }

    func flush() throws { if dirty { try persistIndex() } }

    func stats() -> EmojiStorageStats {
        var snapshot = counters
        snapshot.entries = entries.count
        snapshot.imageBytes = imageBytes
        snapshot.totalStorageBytes = actualStorageBytes()
        return snapshot
    }

    private var indexURL: URL { root.appendingPathComponent("index.json") }
    private var imageBytes: Int { entries.values.reduce(0) { $0 + $1.bytes } }
    private func currentRevision(_ id: String, _ namespace: String) -> UInt64 {
        max(revisions["\(namespace)/\(id)"] ?? 0, namespaceRevisions[namespace] ?? 0)
    }
    private func validNamespace(_ namespace: String) -> Bool {
        namespace.utf8.count == 64 && namespace.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private func validKey(_ key: EmojiAssetKey) -> Bool {
        EmojiAssetKey(id: key.id, representation: key.representation, version: key.version) != nil
    }
    private func readFile(_ url: URL, key: EmojiAssetKey) throws -> EmojiAsset {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= policy.assetBytesMax else { throw StoreError.invalidAsset }
        let data = try Data(contentsOf: url)
        guard data.count == size, key.representation.validates(data) else { throw StoreError.invalidAsset }
        return EmojiAsset(data: data, contentType: key.representation.contentType)
    }
    private func encode(_ values: [String: Entry]) throws -> Data {
        try JSONEncoder().encode(Index(version: 1, entries: values.values.sorted { $0.path < $1.path }))
    }
    private func oldestPath() -> String? {
        entries.values.min { $0.accessed == $1.accessed ? $0.path < $1.path : $0.accessed < $1.accessed }?.path
    }
    private func deleteEntry(_ path: String) throws {
        guard entries[path] != nil else { return }
        try removeFile(root.appendingPathComponent(path))
        entries.removeValue(forKey: path)
        dirty = true
    }
    private func removeFile(_ url: URL) throws {
        do { try files.removeItem(at: url) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError { }
    }
    private func persistIndex() throws {
        var data = try encode(entries)
        while imageBytes + fileSize(indexURL) + data.count > limit {
            guard let oldest = oldestPath() else {
                try removeFile(indexURL)
                dirty = false
                return
            }
            try deleteEntry(oldest)
            counters.sizeEvictions += 1
            data = try encode(entries)
        }
        try atomicWrite(data, to: indexURL)
        dirty = false
    }
    private func atomicWrite(_ data: Data, to destination: URL) throws {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? removeFile(temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try excludeFromBackup(temporary)
        guard rename(temporary.path, destination.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
    private func excludeFromBackup(_ url: URL) throws {
        var value = url
        var attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true
        try value.setResourceValues(attributes)
    }
    private func fileSize(_ url: URL) -> Int { (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
    private func actualStorageBytes() -> Int {
        guard let enumerator = files.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) else { return 0 }
        return enumerator.reduce(0) { result, object in
            guard let url = object as? URL, let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), values.isRegularFile == true else { return result }
            return result + (values.fileSize ?? 0)
        }
    }
}
