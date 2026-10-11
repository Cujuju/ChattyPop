import Photos
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Serves SHELL_ASSET_SCHEME to the paired page: photo thumbnails and persistent v1 emoji images.
/// The page loads them as `<img>`s: WebKit lets an https page show an app scheme's images, but not fetch from it.
@MainActor
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
    private let emoji: any EmojiImageLoader
    /// Tasks WebKit hasn't stopped. Touched only on the main queue: a stopped task mustn't be answered.
    private var live = Set<ObjectIdentifier>()
    private var emojiTokens: [ObjectIdentifier: EmojiRequestToken] = [:]

    init(thumbnails: ShellThumbnails, emoji: any EmojiImageLoader, allowedOrigin: @escaping () -> URL?) {
        self.thumbnails = thumbnails
        self.emoji = emoji
        self.allowedOrigin = allowedOrigin
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        guard let url = task.request.url, let origin = allowedOrigin(), Self.fromPage(task.request, origin: origin) else {
            return fail(task, status: Self.forbiddenStatus)
        }
        // Emoji access is independent of the user's Photos permission.
        if url.host == "emoji" {
            guard let key = EmojiAssetKey(assetURL: url) else { return fail(task, status: Self.notFoundStatus) }
            let id = ObjectIdentifier(task)
            emojiTokens[id] = emoji.load(key) { [weak self] result in
                guard let self, self.live.contains(id) else { return }
                self.emojiTokens.removeValue(forKey: id)
                // Pairing changes can occur while lookup/download is pending.
                guard let current = self.allowedOrigin(), Self.fromPage(task.request, origin: current) else {
                    return self.fail(task, status: Self.forbiddenStatus)
                }
                switch result {
                case .success(let asset): self.respond(task, type: asset.contentType, data: asset.data, cache: "private, max-age=31536000, immutable")
                case .failure: self.fail(task, status: Self.notFoundStatus)
                }
            }
            return
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
        let id = ObjectIdentifier(task)
        live.remove(id)
        if let token = emojiTokens.removeValue(forKey: id) { emoji.cancel(token) }
    }

    /// The request comes from a document on the paired origin.
    private static func fromPage(_ request: URLRequest, origin: URL) -> Bool {
        emojiSameOrigin(request.mainDocumentURL, origin)
    }

    private func respond(_ task: WKURLSchemeTask, type: String, data: Data, cache: String) {
        let id = ObjectIdentifier(task)
        guard live.contains(id), let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: Self.okStatus, httpVersion: nil,
                                             headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": cache]) else { return }
        task.didReceive(response)
        guard live.contains(id) else { return }
        task.didReceive(data)
        guard live.contains(id) else { return }
        task.didFinish()
        live.remove(id)
    }

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        let id = ObjectIdentifier(task)
        guard live.contains(id), let url = task.request.url else { return }
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Cache-Control": "no-store"]) { task.didReceive(response) }
        guard live.contains(id) else { return }
        task.didFinish()
        live.remove(id)
    }
}
