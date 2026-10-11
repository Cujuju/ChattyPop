import Foundation
import ImageIO
import UIKit
import WebKit
import XCTest
@testable import App

@MainActor
private final class ProbeLoader: EmojiImageLoader {
    var callbacks: [EmojiRequestToken: (Result<EmojiAsset, EmojiLoadFailure>) -> Void] = [:]
    var cancelled = Set<EmojiRequestToken>()
    func replacePairing(with context: EmojiPairingContext?) { }
    func load(_ key: EmojiAssetKey, completion: @escaping (Result<EmojiAsset, EmojiLoadFailure>) -> Void) -> EmojiRequestToken {
        let token = EmojiRequestToken(); callbacks[token] = completion; return token
    }
    func cancel(_ token: EmojiRequestToken) { cancelled.insert(token) }
    func remove(ids: Set<String>) { }
    func purgeMemory() { }
    func flush() { }
    func close() { }
    func stats() async -> EmojiCacheStats { EmojiCacheStats() }
}

private final class SchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var events: [String] = []
    var response: HTTPURLResponse?
    var receivedResponse: (() -> Void)?
    init(url: String = "chattypop-asset://emoji/v1/123456789012346.webp", document: String? = "https://desktop.ts.net:443/page") {
        var request = URLRequest(url: URL(string: url)!)
        request.mainDocumentURL = document.flatMap(URL.init(string:))
        self.request = request
    }
    func didReceive(_ response: URLResponse) { self.response = response as? HTTPURLResponse; events.append("response"); receivedResponse?() }
    func didReceive(_ data: Data) { events.append("data") }
    func didFinish() { events.append("finish") }
    func didFailWithError(_ error: Error) { events.append("error") }
}

private final class ImageReports: NSObject, WKScriptMessageHandler {
    let callback: (WKScriptMessage) -> Void
    init(_ callback: @escaping (WKScriptMessage) -> Void) { self.callback = callback }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { callback(message) }
}

@MainActor
final class ShellEmojiSchemeTests: XCTestCase {
    private let origin = URL(string: "https://desktop.ts.net")!

    func testStoppedSchemeTaskIsNeverAnsweredAndOtherCallerRemainsLive() {
        let loader = ProbeLoader()
        let handler = ShellAssetSchemeHandler(thumbnails: ShellThumbnails(), emoji: loader) { self.origin }
        let view = WKWebView()
        let stopped = SchemeTask(), live = SchemeTask()
        handler.webView(view, start: stopped)
        handler.webView(view, start: live)
        handler.webView(view, stop: stopped)
        for callback in loader.callbacks.values { callback(.success(emojiAsset())) }
        XCTAssertTrue(stopped.events.isEmpty)
        XCTAssertEqual(live.events, ["response", "data", "finish"])
        XCTAssertEqual(loader.cancelled.count, 1)
        XCTAssertEqual(live.response?.statusCode, 200)
    }

    func testReentrantStopDuringResponseSuppressesDataAndFinish() {
        let loader = ProbeLoader()
        let handler = ShellAssetSchemeHandler(thumbnails: ShellThumbnails(), emoji: loader) { self.origin }
        let view = WKWebView(), task = SchemeTask()
        task.receivedResponse = { handler.webView(view, stop: task) }
        handler.webView(view, start: task)
        loader.callbacks.values.first?(.success(emojiAsset()))
        XCTAssertEqual(task.events, ["response"])
    }

    func testUnknownOriginAndMalformedAssetFailWithoutCallingLoader() {
        let loader = ProbeLoader()
        let handler = ShellAssetSchemeHandler(thumbnails: ShellThumbnails(), emoji: loader) { self.origin }
        let view = WKWebView()
        for document in [nil, "https://other.ts.net/page", "https://desktop.ts.net:444/page"] as [String?] {
            let task = SchemeTask(document: document)
            handler.webView(view, start: task)
            XCTAssertEqual(task.response?.statusCode, 403)
            XCTAssertEqual(task.response?.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        }
        let invalid = SchemeTask(url: "chattypop-asset://emoji/v2/123456789012346.webp")
        handler.webView(view, start: invalid)
        XCTAssertEqual(invalid.response?.statusCode, 404)
        XCTAssertTrue(loader.callbacks.isEmpty)
    }

    func testWebKitDrawsRetainedWebPAndAnimatedGIFAfterWebsiteCacheRemoval() async throws {
        let root = temporaryRoot()
        let webp = Data(base64Encoded: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")!
        let gif = try animatedGIF()
        EmojiHTTPStub.configure { stub in
            let animated = stub.request.url?.pathExtension == "gif"
            stub.respond(mime: animated ? "image/gif" : "image/webp", chunks: [animated ? gif : webp])
        }
        let http = URLSessionConfiguration.ephemeral
        http.protocolClasses = [EmojiHTTPStub.self]
        let downloader = ShellEmojiDownloader(configuration: http)
        for round in 0..<3 {
            let store = ShellEmojiStore(root: root)
            let cache = ShellEmojiCache(store: store, downloader: downloader)
            cache.replacePairing(with: pairing())
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.setURLSchemeHandler(ShellAssetSchemeHandler(thumbnails: ShellThumbnails(), emoji: cache) { self.origin }, forURLScheme: ShellAssetSchemeHandler.scheme)
            let loaded = expectation(description: "WebKit renders both images in round \(round)")
            loaded.expectedFulfillmentCount = 2
            let reports = ImageReports { message in
                let body = message.body as? [String: Any]
                XCTAssertEqual(body?["ok"] as? Bool, true, "\(message.body)")
                loaded.fulfill()
            }
            configuration.userContentController.add(reports, name: "report")
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 200, height: 200), configuration: configuration)
            let window = UIWindow(frame: UIScreen.main.bounds)
            let controller = UIViewController(); controller.view = view
            window.rootViewController = controller; window.makeKeyAndVisible()
            let html = """
            <body><script>
            for (const ext of ['webp', 'gif']) {
              const image = new Image();
              image.onload = () => webkit.messageHandlers.report.postMessage({ok:image.naturalWidth > 0, ext});
              image.onerror = () => webkit.messageHandlers.report.postMessage({ok:false, ext});
              image.src = 'chattypop-asset://emoji/v1/\(emojiKey().id).' + ext;
              document.body.append(image);
            }
            </script></body>
            """
            view.loadHTMLString(html, baseURL: origin)
            await fulfillment(of: [loaded], timeout: 10)
            cache.purgeMemory()
            await withCheckedContinuation { continuation in
                configuration.websiteDataStore.removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast) { continuation.resume() }
            }
            let stats = await cache.stats()
            XCTAssertEqual(stats.diskHits, round == 0 ? 0 : 2)
            XCTAssertEqual(stats.uniqueDownloads, round == 0 ? 2 : 0)
            XCTAssertEqual(EmojiHTTPStub.observed.count, 2) // subsequent views contact no desktop image endpoint
            cache.close()
            view.stopLoading()
            window.isHidden = true
        }
        XCTAssertEqual(EmojiHTTPStub.observed.count, 2)
        XCTAssertEqual(CGImageSourceGetCount(CGImageSourceCreateWithData(gif as CFData, nil)!), 2)
    }

    private func animatedGIF() throws -> Data {
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, "com.compuserve.gif" as CFString, 2, nil))
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        for color in [UIColor.red, .blue] {
            let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
            CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }
}
