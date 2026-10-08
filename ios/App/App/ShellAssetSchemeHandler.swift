import Photos
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Serves SHELL_ASSET_SCHEME to the paired page: `thumb/<id>?px=<side>`, a square JPEG of a library item (ShellThumbnails).
/// The page loads them as `<img>`s: WebKit lets an https page show an app scheme's images, but not fetch from it.
final class ShellAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    // Mirrors SHELL_ASSET_SCHEME, SHELL_ASSET_HOSTS, SHELL_THUMB_SIZE_PARAM and SHELL_THUMB_PX_MAX in src/shared/shell.ts.
    static let scheme = "chattypop-asset"
    private static let thumbHost = "thumb"
    private static let sizeParameter = "px"
    private static let thumbMax = 1024
    private static let okStatus = 200
    private static let forbiddenStatus = 403
    private static let notFoundStatus = 404
    /// A full thumbnail stays in WebKit's memory cache this long, so reopening the sheet shows the grid without asking again.
    /// Short, because an edited photo keeps its id: its old picture shows at most this long.
    private static let thumbCache = "private, max-age=600"
    /// A rough first image is never kept: the next ask may get the full one.
    private static let roughCache = "no-store"

    /// The paired origin the page must be from; nil serves nothing.
    private let allowedOrigin: () -> URL?
    private let thumbnails: ShellThumbnails
    /// Tasks WebKit hasn't stopped. Touched only on the main queue: a stopped task mustn't be answered.
    private var live = Set<ObjectIdentifier>()

    init(thumbnails: ShellThumbnails, allowedOrigin: @escaping () -> URL?) {
        self.thumbnails = thumbnails
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
        thumbnails.thumbnail(id: String(url.path.dropFirst()), side: min(max(side, 1), Self.thumbMax)) { [weak self] thumbnail in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let thumbnail, let mime = UTType.jpeg.preferredMIMEType else { return self.fail(task, status: Self.notFoundStatus) }
                self.respond(task, type: mime, data: thumbnail.data, cache: thumbnail.final ? Self.thumbCache : Self.roughCache)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    /// The request comes from a document on the paired origin.
    private static func fromPage(_ request: URLRequest, origin: URL) -> Bool {
        guard let document = request.mainDocumentURL else { return false }
        return document.scheme == origin.scheme && document.host?.lowercased() == origin.host?.lowercased() && document.port == origin.port
    }

    private func respond(_ task: WKURLSchemeTask, type: String, data: Data, cache: String) {
        guard live.remove(ObjectIdentifier(task)) != nil, let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: Self.okStatus, httpVersion: nil,
                                             headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": cache]) else { return }
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
