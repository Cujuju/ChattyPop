import Foundation
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

final class EmojiTypesTests: XCTestCase {
    func testStrictAssetURLs() {
        for suffix in ["123456789012345.webp", "123456789012345678901.gif"] {
            XCTAssertNotNil(EmojiAssetKey(assetURL: URL(string: "chattypop-asset://emoji/v1/\(suffix)")!))
        }
        for url in ["https://emoji/v1/123456789012345.webp", "chattypop-asset://thumb/v1/123456789012345.webp",
                    "chattypop-asset://emoji:42/v1/123456789012345.webp", "chattypop-asset://user@emoji/v1/123456789012345.webp",
                    "chattypop-asset://emoji/v2/123456789012345.webp", "chattypop-asset://emoji/v1/123.webp",
                    "chattypop-asset://emoji/v1/123456789012345.webp?url=https://other.test", "chattypop-asset://emoji/v1/123456789012345.webp#x",
                    "chattypop-asset://emoji/v1/123456789012345%2F.webp", "chattypop-asset://emoji/v1//123456789012345.webp",
                    "chattypop-asset://emoji/v1/123456789012345.jpg"] {
            XCTAssertNil(EmojiAssetKey(assetURL: URL(string: url)!), url)
        }
    }

    func testPairingFingerprintAndEffectivePort() {
        let first = EmojiPairingContext(origin: URL(string: "https://DESKTOP.ts.net:443")!, token: "secret")!
        let second = EmojiPairingContext(origin: URL(string: "https://desktop.ts.net")!, token: "secret")!
        XCTAssertEqual(first.namespace, second.namespace)
        XCTAssertNotEqual(first.namespace, EmojiPairingContext(origin: second.origin, token: "replacement")!.namespace)
        XCTAssertFalse(first.namespace.contains("secret"))
        XCTAssertTrue(emojiSameOrigin(URL(string: "https://desktop.ts.net:443/page"), first.origin))
        XCTAssertFalse(emojiSameOrigin(URL(string: "https://desktop.ts.net:444/page"), first.origin))
        XCTAssertNil(EmojiPairingContext(origin: first.origin, token: "cookie; injection"))
        XCTAssertNil(EmojiPairingContext(origin: URL(string: "http://desktop.ts.net")!, token: "x"))
    }
}
