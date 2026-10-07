import Photos
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Serves SHELL_ASSET_SCHEME to the paired page: `thumb/<id>?px=<side>`, a square JPEG of a library item from PhotoKit's cache.
/// The page loads them as `<img>`s: WebKit lets an https page show an app scheme's images, but not fetch from it.
final class ShellAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    // Mirrors SHELL_ASSET_SCHEME, SHELL_ASSET_HOSTS, SHELL_THUMB_SIZE_PARAM and SHELL_THUMB_PX_MAX in src/shared/shell.ts.
    static let scheme = "chattypop-asset"
    private static let thumbHost = "thumb"
    private static let sizeParameter = "px"
    private static let thumbMax = 1024
    private static let thumbQuality: CGFloat = 0.8
    private static let okStatus = 200
    private static let forbiddenStatus = 403
    private static let notFoundStatus = 404

    /// The paired origin the page must be from; nil serves nothing.
    private let allowedOrigin: () -> URL?
    private let images = PHCachingImageManager()
    private let queue = DispatchQueue(label: "com.cujuju.chattypop.asset-scheme", qos: .userInitiated)
    /// Tasks WebKit hasn't stopped. Touched only on the main queue: a stopped task mustn't be answered.
    private var live = Set<ObjectIdentifier>()

    init(allowedOrigin: @escaping () -> URL?) {
        self.allowedOrigin = allowedOrigin
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        guard let url = task.request.url, let origin = allowedOrigin(), Self.fromPage(task.request, origin: origin) else {
            return fail(task, status: Self.forbiddenStatus)
        }
        guard url.host == Self.thumbHost, PHPhotoLibrary.authorizationStatus(for: .readWrite) != .denied else {
            return fail(task, status: Self.notFoundStatus)
        }
        let side = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == Self.sizeParameter }?.value.flatMap(Int.init) ?? Self.thumbMax
        thumbnail(task, id: String(url.path.dropFirst()), side: min(max(side, 1), Self.thumbMax))
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    /// The request comes from a document on the paired origin.
    private static func fromPage(_ request: URLRequest, origin: URL) -> Bool {
        guard let document = request.mainDocumentURL else { return false }
        return document.scheme == origin.scheme && document.host?.lowercased() == origin.host?.lowercased() && document.port == origin.port
    }

    private func thumbnail(_ task: WKURLSchemeTask, id: String, side: Int) {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            return fail(task, status: Self.notFoundStatus)
        }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        let square = CGSize(width: side, height: side)
        images.requestImage(for: asset, targetSize: square, contentMode: .aspectFill, options: options) { [weak self] image, _ in
            guard let self else { return }
            self.queue.async {
                guard let image, let data = Self.cropped(image, to: square).jpegData(compressionQuality: Self.thumbQuality),
                      let mime = UTType.jpeg.preferredMIMEType else {
                    return DispatchQueue.main.async { self.fail(task, status: Self.notFoundStatus) }
                }
                DispatchQueue.main.async { self.respond(task, type: mime, data: data) }
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

    private func respond(_ task: WKURLSchemeTask, type: String, data: Data) {
        guard live.remove(ObjectIdentifier(task)) != nil, let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: Self.okStatus, httpVersion: nil,
                                             headerFields: ["Content-Type": type, "Content-Length": String(data.count)]) else { return }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        guard live.remove(ObjectIdentifier(task)) != nil, let url = task.request.url else { return }
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) { task.didReceive(response) }
        task.didFinish()
    }
}
