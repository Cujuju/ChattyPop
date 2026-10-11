import CryptoKit
import Foundation

enum EmojiRepresentation: String, Codable, Sendable {
    case webp, gif

    var contentType: String { self == .webp ? "image/webp" : "image/gif" }

    func validates(_ data: Data) -> Bool {
        switch self {
        case .webp:
            return data.count >= 12 && data.prefix(4) == Data("RIFF".utf8) && data.dropFirst(8).prefix(4) == Data("WEBP".utf8)
        case .gif:
            return data.count >= 10 && [Data("GIF87a".utf8), Data("GIF89a".utf8)].contains(data.prefix(6))
        }
    }
}

struct EmojiAssetKey: Hashable, Codable, Sendable {
    let id: String
    let representation: EmojiRepresentation
    let version: Int

    init?(id: String, representation: EmojiRepresentation, version: Int = 1) {
        guard version == 1, (15...21).contains(id.utf8.count), id.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        self.id = id
        self.representation = representation
        self.version = version
    }

    init?(assetURL: URL) {
        guard let parts = URLComponents(url: assetURL, resolvingAgainstBaseURL: false),
              parts.scheme == "chattypop-asset", parts.host == "emoji", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !parts.percentEncodedPath.contains("%") else { return nil }
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.count == 3, path[0].isEmpty, path[1] == "v1" else { return nil }
        let filename = path[2].split(separator: ".", omittingEmptySubsequences: false)
        guard filename.count == 2, let representation = EmojiRepresentation(rawValue: String(filename[1])) else { return nil }
        self.init(id: String(filename[0]), representation: representation)
    }

    var filename: String { "\(id).\(representation.rawValue)" }
}

struct EmojiAsset: Sendable {
    let data: Data
    let contentType: String
}

struct EmojiPairingContext: Sendable, Equatable {
    let origin: URL
    let namespace: String
    let generation: UUID
    let cookieHeader: String

    init?(origin: URL, token: String, generation: UUID = UUID()) {
        guard var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", !token.isEmpty,
              token.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e && ![0x22, 0x2c, 0x3b, 0x5c].contains($0) }) else { return nil }
        parts.host = host.lowercased()
        parts.path = ""
        if parts.port == 443 { parts.port = nil }
        guard let normalized = parts.url else { return nil }
        self.origin = normalized
        self.cookieHeader = "cp_companion=\(token)"
        self.namespace = emojiDigest(Data("\(normalized.absoluteString)\n\(cookieHeader)".utf8))
        self.generation = generation
    }

    func sourceURL(for key: EmojiAssetKey) -> URL {
        origin.appendingPathComponent("media/emoji/\(key.filename)")
    }
}

func emojiSameOrigin(_ document: URL?, _ origin: URL) -> Bool {
    guard let document, document.scheme == "https", origin.scheme == "https" else { return false }
    return document.host?.lowercased() == origin.host?.lowercased() && (document.port ?? 443) == (origin.port ?? 443)
}

func emojiDigest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

struct EmojiCachePolicy: Sendable {
    var diskBytesMax = 128 * 1024 * 1024
    var memoryBytesMax = 16 * 1024 * 1024
    var assetBytesMax = 8 * 1024 * 1024
    var downloadsMax = 4
    var queuedDownloadsMax = 256
    var requestTimeout: TimeInterval = 30
    var resourceTimeout: TimeInterval = 60
}

struct EmojiWritePermit: Sendable {
    let key: EmojiAssetKey
    let namespace: String
    let generation: UUID
    let revision: UInt64
}

struct EmojiStorageStats: Sendable {
    var entries = 0
    var imageBytes = 0
    var totalStorageBytes = 0
    var recoveryRemovals = 0
    var sizeEvictions = 0
    var writeFailures = 0
}

struct EmojiCacheStats: Sendable {
    var storage = EmojiStorageStats()
    var memoryHits = 0
    var diskHits = 0
    var misses = 0
    var uniqueDownloads = 0
    var coalescedCallers = 0
    var cancellations = 0
    var failedDownloads = 0
    var bytesDownloaded = 0
    var activeDownloads = 0
    var queuedDownloads = 0
    var queueWaitSeconds: TimeInterval = 0
}

struct EmojiRequestToken: Hashable, Sendable { let id = UUID() }

enum EmojiLoadFailure: Error, Sendable, Equatable {
    case unpaired, invalidAsset, unsupportedVersion, queueFull, cancelled
    case upstream(status: Int)
    case invalidResponse, tooLarge, transport
}

protocol EmojiStore: Sendable {
    func recover() async throws
    func activate(namespace: String, generation: UUID) async
    func deactivate(generation: UUID) async
    func beginLoad(_ key: EmojiAssetKey, namespace: String, generation: UUID) async -> EmojiWritePermit?
    func read(_ key: EmojiAssetKey, namespace: String) async throws -> EmojiAsset?
    func touch(_ key: EmojiAssetKey, namespace: String) async
    func write(_ asset: EmojiAsset, permit: EmojiWritePermit) async throws
    func remove(ids: Set<String>, namespace: String) async throws
    func trim(to maximumBytes: Int) async throws
    func clear(namespace: String) async throws
    func flush() async throws
    func stats() async -> EmojiStorageStats
}

protocol EmojiDownloader: Sendable {
    func download(_ key: EmojiAssetKey, context: EmojiPairingContext, policy: EmojiCachePolicy) async throws -> EmojiAsset
}

@MainActor
protocol EmojiImageLoader: AnyObject {
    func replacePairing(with context: EmojiPairingContext?)
    @discardableResult func load(_ key: EmojiAssetKey, completion: @escaping (Result<EmojiAsset, EmojiLoadFailure>) -> Void) -> EmojiRequestToken
    func cancel(_ token: EmojiRequestToken)
    func remove(ids: Set<String>)
    func purgeMemory()
    func flush()
    func close()
    func stats() async -> EmojiCacheStats
}
