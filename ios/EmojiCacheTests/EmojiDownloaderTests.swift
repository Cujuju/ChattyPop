import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

final class EmojiHTTPStub: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var action: ((EmojiHTTPStub) -> Void)?
    private static var requests: [URLRequest] = []
    private static var stops = 0
    static func configure(_ action: @escaping (EmojiHTTPStub) -> Void) {
        lock.withLock { self.action = action; requests = []; stops = 0 }
    }
    static var observed: [URLRequest] { lock.withLock { requests } }
    static var stopped: Int { lock.withLock { stops } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let action = Self.lock.withLock { () -> ((EmojiHTTPStub) -> Void)? in Self.requests.append(request); return Self.action }
        action?(self)
    }
    override func stopLoading() { Self.lock.withLock { Self.stops += 1 } }
    func respond(status: Int = 200, mime: String = "image/webp", chunks: [Data] = [emojiAsset().data], length: Int? = nil) {
        var headers = ["Content-Type": mime]
        if let length { headers["Content-Length"] = String(length) }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class EmojiDownloaderTests: XCTestCase {
    private func downloader(policy: EmojiCachePolicy = EmojiCachePolicy()) -> ShellEmojiDownloader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EmojiHTTPStub.self]
        return ShellEmojiDownloader(policy: policy, configuration: configuration)
    }

    func testUsesExistingEndpointAndOnlyPairingCookieForBothFormats() async throws {
        for representation in [EmojiRepresentation.webp, .gif] {
            EmojiHTTPStub.configure { $0.respond(mime: representation.contentType, chunks: [emojiAsset(representation).data]) }
            let context = pairing(), key = emojiKey(1, representation)
            let image = try await downloader().download(key, context: context, policy: EmojiCachePolicy())
            XCTAssertEqual(image.data, emojiAsset(representation).data)
            let request = try XCTUnwrap(EmojiHTTPStub.observed.first)
            XCTAssertEqual(request.url?.absoluteString, "https://desktop.ts.net/media/emoji/\(key.filename)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), context.cookieHeader)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), representation.contentType)
            XCTAssertFalse(request.httpShouldHandleCookies)
        }
    }

    func testErrorStatusesAreFailures() async throws {
        for status in [401, 404, 500, 503] {
            EmojiHTTPStub.configure { $0.respond(status: status) }
            do { _ = try await downloader().download(emojiKey(), context: pairing(), policy: EmojiCachePolicy()); XCTFail("Status accepted") }
            catch EmojiLoadFailure.upstream(let actual) { XCTAssertEqual(actual, status) }
        }
    }

    func testRejectsWrongMimeSignatureAndEmptyBody() async throws {
        for (mime, data) in [("text/html", emojiAsset().data), ("application/json", Data("{}".utf8)),
                             ("image/gif", emojiAsset().data), ("image/webp", Data("<html>bad</html>".utf8)), ("image/webp", Data())] {
            EmojiHTTPStub.configure { $0.respond(mime: mime, chunks: [data]) }
            do { _ = try await downloader().download(emojiKey(), context: pairing(), policy: EmojiCachePolicy()); XCTFail("Invalid image accepted") }
            catch EmojiLoadFailure.invalidResponse { }
        }
    }

    func testStreamingLimitWithMissingAndFalseContentLength() async throws {
        var policy = EmojiCachePolicy(); policy.assetBytesMax = 200
        for length in [nil, 1, 300] as [Int?] {
            EmojiHTTPStub.configure { $0.respond(chunks: [emojiAsset().data, Data(repeating: 1, count: 128)], length: length) }
            do { _ = try await downloader(policy: policy).download(emojiKey(), context: pairing(), policy: policy); XCTFail("Streaming size cap exceeded") }
            catch EmojiLoadFailure.tooLarge { }
        }
    }

    func testCancellationStopsHungRequestAndCancelledStartup() async throws {
        EmojiHTTPStub.configure { _ in }
        let http = downloader()
        let request = Task { try await http.download(emojiKey(), context: pairing(), policy: EmojiCachePolicy()) }
        await eventually { !EmojiHTTPStub.observed.isEmpty }
        request.cancel()
        do { _ = try await request.value; XCTFail("Cancelled request returned") }
        catch EmojiLoadFailure.cancelled { }
        await eventually { EmojiHTTPStub.stopped > 0 }
        let early = Task { try await http.download(emojiKey(), context: pairing(), policy: EmojiCachePolicy()) }
        early.cancel()
        do { _ = try await early.value; XCTFail("Cancelled startup returned") }
        catch { XCTAssertTrue(error is CancellationError || error as? EmojiLoadFailure == .cancelled) }
    }

    func testRedirectDoesNotRequestDestinationOrSendCookie() async throws {
        EmojiHTTPStub.configure { stub in
            let response = HTTPURLResponse(url: stub.request.url!, statusCode: 302, httpVersion: nil,
                                           headerFields: ["Location": "https://other.ts.net/leak"])!
            stub.client?.urlProtocol(stub, wasRedirectedTo: URLRequest(url: URL(string: "https://other.ts.net/leak")!), redirectResponse: response)
        }
        do { _ = try await downloader().download(emojiKey(), context: pairing(), policy: EmojiCachePolicy()); XCTFail("Redirect followed") }
        catch EmojiLoadFailure.invalidResponse { }
        XCTAssertEqual(EmojiHTTPStub.observed.count, 1)
        XCTAssertEqual(EmojiHTTPStub.observed.first?.url?.host, "desktop.ts.net")
    }
}
