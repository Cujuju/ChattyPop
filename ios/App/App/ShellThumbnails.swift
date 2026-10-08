import OSLog
import Photos
import UIKit

/// The attach grid's square JPEG thumbnails, served by ShellAssetSchemeHandler. Keeps the items `recent` listed (so a request
/// needn't fetch its item), pre-draws the first page's at the side the page last asked for, and keeps each finished JPEG.
/// Sendable through its lock.
final class ShellThumbnails: @unchecked Sendable {
    /// Intervals for Instruments' os_signpost track: `recent` pages and each thumbnail, from request to answer.
    static let signposter = OSSignposter(subsystem: "com.cujuju.chattypop", category: "Photos")
    private static let quality: CGFloat = 0.8
    /// How many of the first page's items are pre-drawn: a phone's opening sheet shows about 20 cells, and a quick scroll the next screens.
    private static let precacheMax = 60
    /// Bytes of encoded thumbnails kept: about 1,000 grid cells at 3x, so a reopen draws none again.
    private static let encodedBytesMax = 32 * 1024 * 1024
    /// A first, rough image is answered when its shorter side is at least this share of the side asked for: sharp enough for a
    /// cell, where waiting for the full one (from iCloud, maybe) leaves it blank. A scheme task answers only once.
    private static let roughEnough: CGFloat = 0.75

    struct Thumbnail {
        let data: Data
        /// The full image, not a rough first one: safe for WebKit and this to keep.
        let final: Bool
    }

    private let images = PHCachingImageManager()
    private let queue = DispatchQueue(label: "com.cujuju.chattypop.thumbnails", qos: .userInitiated)
    private let lock = NSLock()
    /// The items `recent` listed, by id.
    private var listed: [String: PHAsset] = [:]
    private var firstPage: [PHAsset] = []
    /// The side being pre-drawn, the page's last; nil before its first thumbnail.
    private var cachingSide: Int?
    private let encoded = NSCache<NSString, NSData>()

    init() {
        encoded.totalCostLimit = Self.encodedBytesMax
    }

    /// Requests must match the pre-drawing's options to use what it drew.
    private static let options: PHImageRequestOptions = {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        return options
    }()

    private static func square(_ side: Int) -> CGSize { CGSize(width: side, height: side) }

    /// The items a `recent` page listed; the first page is pre-drawn once the page's side is known.
    func listed(_ assets: [PHAsset], first: Bool) {
        let side: Int? = lock.withLock {
            for asset in assets { listed[asset.localIdentifier] = asset }
            guard first else { return nil }
            firstPage = Array(assets.prefix(Self.precacheMax))
            return cachingSide
        }
        if let side { precache(side) }
    }

    /// The library changed: an item may be gone or edited under the same id.
    func reset() {
        lock.withLock {
            listed = [:]
            firstPage = []
        }
        encoded.removeAllObjects()
        images.stopCachingImagesForAllAssets()
    }

    private func precache(_ side: Int) {
        let assets = lock.withLock { firstPage }
        images.stopCachingImagesForAllAssets()
        images.startCachingImages(for: assets, targetSize: Self.square(side), contentMode: .aspectFill, options: Self.options)
    }

    /// Item `id`'s thumbnail, `side` pixels square, answered once (any queue); nil when the item is gone or can't be drawn.
    func thumbnail(id: String, side: Int, answer: @escaping (Thumbnail?) -> Void) {
        let key = "\(side)/\(id)" as NSString
        if let data = encoded.object(forKey: key) { return answer(Thumbnail(data: data as Data, final: true)) }
        let signpost = Self.signposter.beginInterval("thumbnail", id: Self.signposter.makeSignpostID(), "px \(side)")
        let (known, newSide) = lock.withLock { () -> (PHAsset?, Bool) in
            let newSide = cachingSide != side
            cachingSide = side
            return (listed[id], newSide)
        }
        if newSide { precache(side) }
        guard let asset = known ?? PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            Self.signposter.endInterval("thumbnail", signpost, "missing")
            return answer(nil)
        }
        let square = Self.square(side)
        // Called on the main queue, a rough image first and then the full one; only one is answered.
        var answered = false
        images.requestImage(for: asset, targetSize: square, contentMode: .aspectFill, options: Self.options) { [self] image, info in
            guard !answered else { return }
            let rough = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
            if rough {
                guard let image, min(image.size.width, image.size.height) * image.scale >= CGFloat(side) * Self.roughEnough else { return }
            }
            answered = true
            queue.async { [self] in
                guard let image, let data = Self.cropped(image, to: square).jpegData(compressionQuality: Self.quality) else {
                    Self.signposter.endInterval("thumbnail", signpost, "failed")
                    return answer(nil)
                }
                if !rough { encoded.setObject(data as NSData, forKey: key, cost: data.count) }
                Self.signposter.endInterval("thumbnail", signpost, "\(rough ? "rough" : "full")")
                answer(Thumbnail(data: data, final: !rough))
            }
        }
    }

    /// The middle of an aspect-filled image, `size` pixels.
    private static func cropped(_ image: UIImage, to size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let fill = max(size.width / image.size.width, size.height / image.size.height)
        let drawn = CGSize(width: image.size.width * fill, height: image.size.height * fill)
        let origin = CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2)
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: origin, size: drawn)) }
    }
}
