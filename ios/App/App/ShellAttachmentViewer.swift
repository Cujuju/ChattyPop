import Capacitor
import QuickLook
import UIKit
import WebKit

/// Cancels document navigation before Capacitor replaces the conversation. The shell validates the sender and attachment URL.
@objc(ShellAttachmentNavigationPlugin)
final class ShellAttachmentNavigationPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ShellAttachmentNavigationPlugin"
    let jsName = "ShellAttachmentNavigation"
    let pluginMethods: [CAPPluginMethod] = []
    var open: ((WKNavigationAction) -> Bool)?

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        open?(navigationAction) == true ? NSNumber(value: true) : nil
    }
}

/// Downloads one archived file using the web view's pairing cookie, then presents native Quick Look or the system share sheet.
final class ShellAttachmentViewer: NSObject, URLSessionTaskDelegate, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private weak var presenter: UIViewController?
    private var loading: UIAlertController?
    private var session: URLSession?
    private var directory: URL?
    private var file: URL?
    private var name = "Attachment"
    private var opening: UUID?
    /// A stalled PC must release the loading state; Cancel remains available throughout.
    private static let requestTimeout: TimeInterval = 60

    func open(_ url: URL, from presenter: UIViewController, webView: WKWebView) {
        guard opening == nil, presenter.presentedViewController == nil else { return }
        let id = UUID()
        opening = id
        self.presenter = presenter
        let alert = UIAlertController(title: "Opening attachment…", message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.cleanUp() })
        loading = alert
        presenter.present(alert, animated: true) { [weak self, weak webView] in
            guard let self, let webView, self.opening == id else { return }
            // The download attribute holds the original filename; the URL holds only its content hash and extension.
            let encoded = String(data: try! JSONSerialization.data(withJSONObject: [url.absoluteString]), encoding: .utf8)!
            webView.evaluateJavaScript("Array.from(document.querySelectorAll('a[download]')).find(a => a.href === \(encoded)[0])?.download") { [weak self] value, _ in
                guard let self, self.opening == id else { return }
                self.name = (value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url.lastPathComponent
                webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
                    guard let self, self.opening == id else { return }
                    let cookie = cookies.first {
                        $0.name == SharedPairing.cookieName && $0.isSecure && $0.path == "/" &&
                        ($0.domain == url.host || $0.domain == ".\(url.host ?? "")") &&
                        ($0.expiresDate.map { $0 > Date() } ?? true)
                    }
                    guard let cookie else { return self.failed("Open ChattyPop and pair with your PC again.") }
                    self.download(url, cookie: cookie, id: id)
                }
            }
        }
    }

    private func download(_ url: URL, cookie: HTTPCookie, id: UUID) {
        var request = URLRequest(url: url, timeoutInterval: Self.requestTimeout)
        request.httpShouldHandleCookies = false
        request.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        session.downloadTask(with: request) { [weak self] temporary, response, error in
            // URLSession removes its temporary file after this callback; move it while the callback is still running.
            DispatchQueue.main.sync {
                guard let self, self.opening == id else { return }
                guard error == nil, let temporary, let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                    return self.failed("Couldn't download the attachment. Check that your PC is online and you're still paired.")
                }
                do {
                    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("attachment-\(id.uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    self.directory = directory
                    // Keep the stored extension for Quick Look, and discard any path components in the display name.
                    let base = (self.name as NSString).lastPathComponent
                    let stem = (base as NSString).deletingPathExtension
                    let safeStem = stem.isEmpty || stem == "." || stem == ".." ? "Attachment" : stem
                    let file = directory.appendingPathComponent(safeStem).appendingPathExtension(url.pathExtension)
                    try FileManager.default.moveItem(at: temporary, to: file)
                    self.file = file
                    self.showFile()
                } catch {
                    self.failed("Couldn't keep a temporary copy of this attachment.")
                }
            }
        }.resume()
    }

    /// Never forward the pairing cookie to a redirect target, or preview a sign-in/error page as the requested file.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    private func showFile() {
        guard let file else { return }
        dismissLoading { [weak self] in
            guard let self, self.opening != nil, let presenter = self.presenter else { return }
            if QLPreviewController.canPreview(file as NSURL) {
                let preview = QLPreviewController()
                preview.dataSource = self
                preview.delegate = self
                // Quick Look owns safe-area-aware Done and Share controls; the conversation stays underneath.
                presenter.present(preview, animated: true)
            } else {
                let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                share.completionWithItemsHandler = { [weak self] _, _, _, _ in self?.cleanUp() }
                share.popoverPresentationController?.sourceView = presenter.view
                share.popoverPresentationController?.sourceRect = CGRect(origin: CGPoint(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY), size: .zero)
                presenter.present(share, animated: true)
            }
        }
    }

    private func failed(_ message: String) {
        dismissLoading { [weak self] in
            guard let self, self.opening != nil, let presenter = self.presenter else { return }
            self.cleanUp()
            let alert = UIAlertController(title: "Couldn't open attachment", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Done", style: .cancel))
            presenter.present(alert, animated: true)
        }
    }

    private func dismissLoading(_ completion: @escaping () -> Void) {
        let alert = loading
        loading = nil
        alert?.dismiss(animated: true, completion: completion)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { file == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        file! as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) { cleanUp() }

    private func cleanUp() {
        opening = nil
        session?.invalidateAndCancel()
        session = nil
        loading = nil
        file = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
        presenter = nil
    }
}
