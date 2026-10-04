import Capacitor
import UserNotifications
import WebKit

class ShellViewController: CAPBridgeViewController, WKHTTPCookieStoreObserver {
    // Mirrors SHELL_SCHEME, SHELL_LINK_HOST and SHELL_LINK_PARAMS in src/shared/shell.ts.
    private static let scheme = "chattypop"
    private static let linkHost = "pair"
    private static let originParameter = "origin"
    private static let codeParameter = "code"
    private static let originKey = "companionOrigin"
    private static let tailnetSuffix = ".ts.net"
    private static let retryHandler = "shellRetry"
    // Mirrors the companion page's backdrop handler (page/browserChrome.ts).
    private static let backdropHandler = "shellBackdrop"
    // Mirrors COMPANION_PATHS.push in the companion plugin's shared/protocol.ts.
    private static let pushPath = "/push"
    /// How long the previous PC gets to forget this phone's push address when it re-pairs; that PC may be off.
    private static let unsubscribeTimeout: TimeInterval = 10
    // Mirrors SHELL_NATIVE_GLOBAL and APNS_ENVIRONMENTS in src/shared/shell.ts.
    private static let nativeGlobal = "chattyPopShell"
    private static let developmentEnvironment = "development"
    private static let productionEnvironment = "production"
    /// The notification tap that launched the app. The scene receives it before Capacitor's notification delegate
    /// exists, so the first bridge to load hands it on.
    static var launchNotification: UNNotificationResponse?
    /// The default dark theme's ground (capacitor.config.ts ios.backgroundColor), until the page posts its own backdrop.
    /// The keyboard's resize uncovers the window and this controller's view, which show in the keyboard's rounded corners.
    static let ground = UIColor(red: 9 / 255, green: 11 / 255, blue: 16 / 255, alpha: 1)
    private var origin: URL?
    private var pairingURL: URL?
    private var cookieStore: WKHTTPCookieStore?
    private var cookieRevision = 0
    /// The web view's bottom, raised by the keyboard's cover.
    private var keyboardBottom: NSLayoutConstraint?
    /// The keyboard's last announced frame, in its screen's coordinates; kept to refit when the window changes.
    private var keyboardFrame: CGRect?
    /// While the keyboard opens, WebKit's offsets to reveal the focused field are undone until then.
    private var revealHeldUntil: Date?
    private var heldOffset: NSKeyValueObservation?
    private var restoringOffset = false
    /// How long after the keyboard's animation WebKit may still try to reveal the focused field.
    private static let revealSettle: TimeInterval = 0.3

    private static var savedOrigin: URL? {
        guard let value = UserDefaults.standard.string(forKey: originKey) else { return nil }
        return validatedOrigin(value)
    }

    private static func validatedOrigin(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value), parts.scheme == "https",
              let host = parts.host?.lowercased(), host.hasSuffix(tailnetSuffix),
              parts.user == nil, parts.password == nil, parts.path.isEmpty,
              parts.query == nil, parts.fragment == nil else { return nil }
        return parts.url
    }

    private static func pairingLink(_ url: URL) -> (origin: URL, page: URL)? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == linkHost, parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems else { return nil }
        let names = [originParameter, codeParameter]
        guard items.count == names.count, Set(items.map(\.name)) == Set(names),
              let value = items.first(where: { $0.name == originParameter })?.value,
              let origin = validatedOrigin(value),
              let code = items.first(where: { $0.name == codeParameter })?.value,
              !code.isEmpty, code.unicodeScalars.allSatisfy({ ("0"..."9").contains(String($0)) }) else { return nil }
        var page = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        // Mirrors COMPANION_PATHS.pair in src/shared/companion.ts.
        page.path = "/pair"
        page.queryItems = [URLQueryItem(name: codeParameter, value: code)]
        guard let pageURL = page.url else { return nil }
        return (origin, pageURL)
    }

    static func handleLink(_ url: URL, in window: UIWindow) {
        guard let link = pairingLink(url) else { return }
        DispatchQueue.main.async { [weak window] in
            guard let window, let presenter = window.rootViewController,
                  presenter.presentedViewController == nil else { return }
            let oldHost = savedOrigin?.host
            let message = oldHost.map { "This replaces \($0)." }
            let alert = UIAlertController(title: "Pair with \(link.origin.host!)?", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            alert.addAction(UIAlertAction(title: "Pair", style: .default) { [weak window] _ in
                guard let window else { return }
                // The PC this phone was paired with (another, or this one under a new pairing) would keep pushing to it.
                if let previous = try? SharedPairing.read() { unsubscribe(from: previous) }
                do {
                    try SharedPairing.write(nil)
                } catch {
                    NSLog("Could not clear companion pairing in the shared Keychain.")
                }
                UserDefaults.standard.set(link.origin.absoluteString, forKey: originKey)
                let controller = ShellViewController()
                controller.pairingURL = link.page
                window.rootViewController = controller
            })
            presenter.present(alert, animated: true)
        }
    }

    /// Asks `pairing`'s PC to stop pushing to this phone (DELETE /push with its pairing cookie). Best effort: a PC that is
    /// off or unreachable keeps pushing until the phone is signed out in its Settings → Phone.
    private static func unsubscribe(from pairing: CompanionPairing) {
        var request = URLRequest(url: pairing.origin.appendingPathComponent(pushPath), timeoutInterval: unsubscribeTimeout)
        request.httpMethod = "DELETE"
        request.httpShouldHandleCookies = false
        request.setValue("\(SharedPairing.cookieName)=\(pairing.token)", forHTTPHeaderField: "Cookie")
        URLSession(configuration: .ephemeral).dataTask(with: request) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            if error != nil || status != 200 { NSLog("Could not stop notifications from the previous PC (status %ld).", status ?? 0) }
        }.resume()
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        origin = Self.savedOrigin
        descriptor.serverURL = origin?.absoluteString
        return descriptor
    }

    /// The APNs environment this build's aps-environment entitlement names, read from its provisioning profile. App Store and
    /// TestFlight builds carry no profile and always use production.
    private static let apsEnvironment: String = {
        // A simulator build has no profile, but its device tokens are sandbox ones.
        #if targetEnvironment(simulator)
        return ShellViewController.developmentEnvironment
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else { return ShellViewController.productionEnvironment }
        // The profile is a signed CMS envelope around a plain XML plist.
        guard let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              entitlements["aps-environment"] as? String == ShellViewController.developmentEnvironment else { return ShellViewController.productionEnvironment }
        return ShellViewController.developmentEnvironment
        #endif
    }()

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Before any page script: the page sends it with this install's device token (companion page/shellPush.ts).
        let global = "window.\(Self.nativeGlobal) = Object.freeze({ apsEnvironment: '\(Self.apsEnvironment)' });"
        configuration.userContentController.addUserScript(WKUserScript(source: global, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = PairingWebView(frame: frame, configuration: configuration)
        view.initialURL = pairingURL
        pairingURL = nil
        return view
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        view.backgroundColor = Self.ground
        installKeyboardContainer()
        // Plugins are loaded now; the push plugin keeps the tap until the page's listener takes it.
        if let response = Self.launchNotification, let bridge {
            Self.launchNotification = nil
            bridge.notificationRouter.userNotificationCenter(UNUserNotificationCenter.current(), didReceive: response, withCompletionHandler: {})
        }
        guard let webView else { return }
        let scripts = webView.configuration.userContentController
        scripts.add(WeakMessageHandler { [weak self] in self?.retry($0) }, name: Self.retryHandler)
        scripts.add(WeakMessageHandler { [weak self] in self?.setBackdrop($0) }, name: Self.backdropHandler)
        let store = webView.configuration.websiteDataStore.httpCookieStore
        cookieStore = store
        store.add(self)
        cookiesDidChange(in: store)
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        guard let origin, let host = origin.host else { return }
        cookieRevision += 1
        let revision = cookieRevision
        cookieStore.getAllCookies { [weak self] cookies in
            guard let self, revision == self.cookieRevision, origin == Self.savedOrigin else { return }
            let cookie = cookies.first {
                $0.name == SharedPairing.cookieName &&
                ($0.domain == host || $0.domain == ".\(host)") && $0.path == "/" && $0.isSecure &&
                ($0.expiresDate.map { $0 > Date() } ?? true)
            }
            do {
                try SharedPairing.write(cookie.map { CompanionPairing(origin: origin, token: $0.value) })
            } catch {
                NSLog("Could not update companion pairing in the shared Keychain.")
            }
        }
    }

    fileprivate func retry(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url == bridge?.config.errorPathURL,
              let origin = Self.savedOrigin else { return }
        webView?.load(URLRequest(url: origin))
    }

    /// capacitor.config.ts sets Keyboard resize 'none': the plugin's 'native' resize waits for the keyboard's animation
    /// plus 0.2 s. Instead the web view sits in a full-window container and its bottom moves to the keyboard's top as soon
    /// as the keyboard announces its frame. The web view's own frame shrinks, so the page's visual viewport and bottom
    /// safe area change as they did under 'native'.
    private func installKeyboardContainer() {
        guard let webView else { return }
        let container = UIView(frame: webView.frame)
        container.backgroundColor = view.backgroundColor
        view = container
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        let bottom = webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        keyboardBottom = bottom
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bottom,
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        // As the keyboard opens, WebKit scrolls the focused field into view by the keyboard's height although the web view
        // already ends above it (the content size still has the pre-keyboard height), so the page draws pushed down for a
        // few frames. While the keyboard opens, a vertical offset WebKit sets is undone before it is drawn; afterwards the
        // focused field is revealed again, which scrolls a page taller than the viewport and leaves the others alone.
        heldOffset = webView.scrollView.observe(\.contentOffset, options: [.old, .new]) { [weak self] scrollView, change in
            guard let self, !self.restoringOffset, let until = self.revealHeldUntil, Date() < until,
                  let old = change.oldValue, let new = change.newValue, old.y != new.y,
                  !scrollView.isDragging, !scrollView.isDecelerating, !scrollView.isZooming,
                  scrollView.zoomScale <= scrollView.minimumZoomScale + 0.01 else { return }
            self.restoringOffset = true
            scrollView.contentOffset = CGPoint(x: new.x, y: old.y)
            self.restoringOffset = false
        }
        // Capacitor's StatusBar plugin sets the web view's frame to the window's on appearing and rotating; the
        // constraints take it back.
        (webView as? PairingWebView)?.frameChanged = { [weak container] in container?.setNeedsLayout() }
    }

    /// A keyboard on this window's screen announces where it will be. An interactive dismiss sends a stream of these.
    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let screen = view.window?.screen,
              (note.object as? UIScreen).map({ $0 === screen }) ?? true,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        keyboardFrame = end
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        // An animated arrival on screen; an interactive dismiss's stream has no duration.
        let opening = duration > 0 && end.minY < screen.bounds.maxY - 1
        revealHeldUntil = opening ? Date().addingTimeInterval(duration + Self.revealSettle) : nil
        fitAboveKeyboard(revealAfter: opening ? duration + Self.revealSettle : nil)
    }

    /// Ends the web view at the top of a docked keyboard over this window. Not animated: WebKit draws an animated resize at
    /// the final size inside the moving frame, which pushes the page down. A floating keyboard covers nothing, and the
    /// cover never exceeds the window.
    private func fitAboveKeyboard(revealAfter delay: TimeInterval? = nil) {
        guard let keyboardBottom, let screen = view.window?.screen else { return }
        var cover: CGFloat = 0
        if let keyboardFrame, keyboardFrame.maxY >= screen.bounds.maxY - 1 {
            let keyboard = view.convert(keyboardFrame, from: screen.coordinateSpace)
            let overlap = view.bounds.intersection(keyboard)
            if !overlap.isNull, overlap.width > 0 { cover = min(view.bounds.maxY - overlap.minY, view.bounds.height) }
        }
        if keyboardBottom.constant != -cover {
            keyboardBottom.constant = -cover
            UIView.performWithoutAnimation { view.layoutIfNeeded() }
        }
        guard let delay else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.webView?.evaluateJavaScript("document.activeElement?.scrollIntoView({ block: 'nearest' })")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The window moved, resized or rotated: refit to the keyboard's last frame.
        fitAboveKeyboard()
    }

    /// The page's `{ r, g, b }` (0–255): the surface above the keyboard, painted behind it on every theme change.
    fileprivate func setBackdrop(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let rgb = message.body as? [String: Any],
              let r = (rgb["r"] as? NSNumber)?.doubleValue,
              let g = (rgb["g"] as? NSNumber)?.doubleValue,
              let b = (rgb["b"] as? NSNumber)?.doubleValue else { return }
        let channel = { (v: Double) in CGFloat(min(max(v, 0), 255) / 255) }
        let color = UIColor(red: channel(r), green: channel(g), blue: channel(b), alpha: 1)
        view.backgroundColor = color
        view.window?.backgroundColor = color
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.retryHandler)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.backdropHandler)
        cookieStore?.remove(self)
    }
}

/** A script message handler that doesn't retain the controller: the user content controller keeps its handlers. */
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private let receive: (WKScriptMessage) -> Void

    init(_ receive: @escaping (WKScriptMessage) -> Void) {
        self.receive = receive
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        receive(message)
    }
}
/** Swaps Capacitor's first request for the confirmed pairing page. A second load would cancel the first, and Capacitor shows its error page for a cancelled load. */
private final class PairingWebView: WKWebView {
    var initialURL: URL?
    /// Called when something other than its constraints may have moved it.
    var frameChanged: (() -> Void)?

    override var frame: CGRect {
        didSet { if frame != oldValue { frameChanged?() } }
    }

    override func load(_ request: URLRequest) -> WKNavigation? {
        guard let initialURL else { return super.load(request) }
        self.initialURL = nil
        return super.load(URLRequest(url: initialURL))
    }
}
