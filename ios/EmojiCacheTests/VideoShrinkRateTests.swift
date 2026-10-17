import CoreGraphics
import XCTest
#if canImport(ChattyPopEmojiCache)
@testable import ChattyPopEmojiCache
#else
@testable import App
#endif

/// ShellVideoShrinker's rate against the page encoder's (videoBitrateFor in src/shared/videoEncode.ts). The presets mirror
/// ENCODE_PRESETS and the targets the page's videoShrink in src/renderer/src/phone/photoLibrary.ts.
final class VideoShrinkRateTests: XCTestCase {
    private let standard = ShellVideoShrinker.Preset(shortSide: 720, videoBitrate: 2_000_000)
    private let dataSaver = ShellVideoShrinker.Preset(shortSide: 480, videoBitrate: 1_000_000)
    /// AUDIO_BITRATE and MAX_FRAME_RATE: neither changes the video rate.
    private let audioBitrate = 128_000
    private let maxFrameRate = 60

    private func target(_ preset: ShellVideoShrinker.Preset, caps: [ShellVideoShrinker.Preset]) -> ShellVideoShrinker.Target {
        ShellVideoShrinker.Target(shortSide: preset.shortSide, videoBitrate: preset.videoBitrate, rateCaps: caps, audioBitrate: audioBitrate, maxFrameRate: maxFrameRate)
    }

    private func rates(_ width: CGFloat, _ height: CGFloat) -> (standard: Int, dataSaver: Int) {
        let source = CGSize(width: width, height: height)
        return (ShellVideoShrinker.videoBitrate(for: source, target: target(standard, caps: [])),
                ShellVideoShrinker.videoBitrate(for: source, target: target(dataSaver, caps: [standard])))
    }

    func testMatchesThePageEncoder() {
        // Regression: Data Saver alone gave 640×360 562,500 bit/s against Standard's 500,000.
        let expected: [(CGFloat, CGFloat, Int, Int)] = [
            (640, 360, 500_000, 500_000), (360, 640, 500_000, 500_000), (854, 480, 888_889, 888_889), (900, 500, 964_506, 964_506),
            (1280, 720, 2_000_000, 1_000_000), (1920, 1080, 2_000_000, 1_000_000), (1320, 2868, 2_000_000, 1_000_000), (2, 2, 15, 15),
        ]
        for (width, height, standardRate, dataSaverRate) in expected {
            let got = rates(width, height)
            XCTAssertEqual(got.standard, standardRate, "\(width)×\(height)")
            XCTAssertEqual(got.dataSaver, dataSaverRate, "\(width)×\(height)")
        }
    }

    func testDataSaverNeverGetsMoreBitsThanStandard() {
        for short in stride(from: 2, through: 2160, by: 2) {
            let side = CGFloat(short)
            for (width, height) in [((side * 16 / 9).rounded(), side), (side, side * 2)] {
                let got = rates(width, height)
                XCTAssertLessThanOrEqual(got.dataSaver, got.standard, "\(width)×\(height)")
            }
        }
    }
}
