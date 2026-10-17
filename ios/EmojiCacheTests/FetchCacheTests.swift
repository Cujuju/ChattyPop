import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

/// ShellFetchCache, which keeps ShellPhotoLibrary's fetched library until a library change.
final class FetchCacheTests: XCTestCase {
    func testKeepsAFetchUntilInvalidated() {
        let cache = ShellFetchCache<String>()
        var fetches = 0
        let fetch = { () -> String in fetches += 1; return "library \(fetches)" }
        XCTAssertEqual(cache.read(keep: true, fetch: fetch), "library 1")
        XCTAssertEqual(cache.read(keep: true, fetch: fetch), "library 1")
        cache.invalidate()
        XCTAssertEqual(cache.read(keep: true, fetch: fetch), "library 2")
        XCTAssertEqual(fetches, 2)
    }

    func testDoesNotKeepAFetchAChangeOvertook() {
        // Regression: a change between the fetch's snapshot and its commit left the old library cached.
        let cache = ShellFetchCache<String>()
        let overtaken = cache.read(keep: true) {
            cache.invalidate()
            return "before the change"
        }
        XCTAssertEqual(overtaken, "before the change")
        XCTAssertEqual(cache.read(keep: true) { "after the change" }, "after the change")
        XCTAssertEqual(cache.read(keep: true) { "unread" }, "after the change")
    }

    func testKeepsNothingUnasked() {
        let cache = ShellFetchCache<String>()
        XCTAssertEqual(cache.read(keep: false) { "first" }, "first")
        XCTAssertEqual(cache.read(keep: true) { "second" }, "second")
    }
}
