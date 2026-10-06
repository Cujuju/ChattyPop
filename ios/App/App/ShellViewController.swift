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
    /// Timeout for revoking the previous PC’s push registration during re-pairing.
    private static let unsubscribeTimeout: TimeInterval = 10
    // Mirrors SHELL_NATIVE_GLOBAL and APNS_ENVIRONMENTS in src/shared/shell.ts.
    private static let nativeGlobal = "chattyPopShell"
    private static let developmentEnvironment = "development"
    private static let productionEnvironment = "production"
    /// Launch notification retained until Capacitor’s first bridge forwards it to the push delegate.
    static var launchNotification: UNNotificationResponse?
    /// Uses the default dark backdrop until the page publishes its own. The underlying window remains visible around the keyboard’s rounded corners.
    static let ground = UIColor(red: 9 / 255, green: 11 / 255, blue: 16 / 255, alpha: 1)
    private var origin: URL?
    private var pairingURL: URL?
    private var cookieStore: WKHTTPCookieStore?
    private var cookieRevision = 0
    /// Last keyboard frame in screen coordinates, reused after window changes.
    private var keyboardFrame: CGRect?
    /// Latest bottom keyboard coverage published to the page.
    private var keyboardCover: CGFloat = 0
    /// Deadline for suppressing WebKit focus-scrolling offsets after keyboard movement.
    private var revealHeldUntil: Date?
    private var heldOffset: NSKeyValueObservation?
    private var restoringOffset = false
    /// Additional focus-scroll suppression interval after keyboard animation.
    private static let revealSettle: TimeInterval = 0.3
    // Mirrors SHELL_KEYBOARD_PROPERTIES in src/shared/shell.ts (the theme's sizes.css reads them).
    private static let keyboardInsetProperty = "--cp-keyboard-inset"
    private static let keyboardDurationProperty = "--cp-keyboard-duration"
    private static let millisecondsPerSecond: Double = 1000

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
                // Revokes the previous PC’s push registration before changing pairings.
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

    /// Requests DELETE /push with the pairing cookie. An unreachable PC retains its push registration until the phone is revoked in Settings.
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

    /// Reads APNs environment from provisioning entitlements. App Store and TestFlight builds use production without a profile.
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
        // The push plugin retains notification taps until the page listener subscribes.
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

    /// Keyboard resize is disabled. The web view stays full-window; keyboard notifications publish coverage and animation duration for the page’s inset.
    private func installKeyboardContainer() {
        guard let webView else { return }
        let container = UIView(frame: webView.frame)
        container.backgroundColor = view.backgroundColor
        view = container
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        // Resets WebKit’s vertical offset while the keyboard is visible or moving. Once settled, reveals the focused field within its scrolling container.
        heldOffset = webView.scrollView.observe(\.contentOffset, options: [.old, .new]) { [weak self] scrollView, change in
            guard let self, !self.restoringOffset,
                  self.keyboardCover > 0 || (self.revealHeldUntil.map { Date() < $0 } ?? false),
                  let old = change.oldValue, let new = change.newValue, old.y != new.y,
                  !scrollView.isDragging, !scrollView.isDecelerating, !scrollView.isZooming,
                  scrollView.zoomScale <= scrollView.minimumZoomScale + 0.01 else { return }
            self.restoringOffset = true
            scrollView.contentOffset = CGPoint(x: new.x, y: old.y)
            self.restoringOffset = false
        }
        // Constraints restore the web view frame after StatusBar updates on appearance or rotation.
        (webView as? PairingWebView)?.frameChanged = { [weak container] in container?.setNeedsLayout() }
    }

    /// Keyboard-frame announcements for this screen; interactive dismissal emits multiple frames.
    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let screen = view.window?.screen,
              (note.object as? UIScreen).map({ $0 === screen }) ?? true,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        keyboardFrame = end
        // Uses the native animation duration; interactive dismissal announcements have none.
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let opening = duration > 0 && end.minY < screen.bounds.maxY - 1
        revealHeldUntil = Date().addingTimeInterval(duration + Self.revealSettle)
        publishKeyboard(duration: duration, revealAfter: opening ? duration + Self.revealSettle : nil)
    }

    /// Publishes docked-keyboard coverage and animation duration. Floating keyboards contribute zero; coverage is bounded by the window height.
    private func publishKeyboard(duration: TimeInterval = 0, revealAfter delay: TimeInterval? = nil) {
        guard let screen = view.window?.screen else { return }
        var cover: CGFloat = 0
        if let keyboardFrame, keyboardFrame.maxY >= screen.bounds.maxY - 1 {
            let keyboard = view.convert(keyboardFrame, from: screen.coordinateSpace)
            let overlap = view.bounds.intersection(keyboard)
            if !overlap.isNull, overlap.width > 0 { cover = min(view.bounds.maxY - overlap.minY, view.bounds.height) }
        }
        if cover != keyboardCover {
            keyboardCover = cover
            let ms = Int((duration * Self.millisecondsPerSecond).rounded())
            let style = "document.documentElement.style"
            webView?.evaluateJavaScript("\(style).setProperty('\(Self.keyboardDurationProperty)', '\(ms)ms'); \(style).setProperty('\(Self.keyboardInsetProperty)', '\(cover)px')")
        }
        guard let delay else { return }
        // Reveals the focused field within its scrolling container after applying the keyboard inset.
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.webView?.evaluateJavaScript("document.activeElement?.scrollIntoView({ block: 'nearest' })")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Recomputes keyboard coverage after window movement, resize, or rotation.
        publishKeyboard()
    }

    /// Page RGB backdrop, with 0–255 components, updated on theme changes.
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

/** Weak controller reference prevents retention through user-content message handlers. */
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private let receive: (WKScriptMessage) -> Void

    init(_ receive: @escaping (WKScriptMessage) -> Void) {
        self.receive = receive
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        receive(message)
    }
}
/** Replaces Capacitor’s initial request with the confirmed pairing page. A separate load cancels the initial request and triggers Capacitor’s error page. */
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
