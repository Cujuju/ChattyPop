import SwiftUI
import UniformTypeIdentifiers

@objc(ShareViewController)
class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
    }
}

private struct ShareTargets: Decodable {
    struct Channel: Decodable, Identifiable {
        let id: String
        let name: String
    }
    struct Guild: Decodable, Identifiable {
        let id: String
        let name: String
        let channels: [Channel]
    }
    let guilds: [Guild]
}

@MainActor
private final class ShareModel: ObservableObject {
    @Published var text = ""
    @Published var channelId = ""
    @Published var guilds: [ShareTargets.Guild] = []
    @Published var error: String?
    @Published var busy = true
    private let context: NSExtensionContext?
    private var pairing: CompanionPairing?
    private let unauthorized = 401
    private let successStatuses = 200..<300
    private let session: URLSession

    init(context: NSExtensionContext?) {
        self.context = context
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
    }

    var canSend: Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !busy && !channelId.isEmpty && !trimmed.isEmpty
    }

    func load() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            if text.isEmpty { text = try await sharedText() }
            pairing = try SharedPairing.read()
            guard pairing != nil else { throw ShareError.message("Open ChattyPop to pair") }
            let data = try await request(method: "GET")
            guilds = try JSONDecoder().decode(ShareTargets.self, from: data).guilds
            // Start on "Choose a channel" so Send needs a deliberate pick; keep a pick that's still valid.
            if !guilds.contains(where: { $0.channels.contains(where: { $0.id == channelId }) }) {
                channelId = ""
            }
            if guilds.isEmpty { error = "No channels archived yet. Choose them on your PC." }
        } catch {
            self.error = message(for: error)
        }
    }

    func send() async {
        guard canSend else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let body = try JSONEncoder().encode(SharePost(channelId: channelId, text: text))
            _ = try await request(method: "POST", body: body)
            context?.completeRequest(returningItems: nil)
        } catch {
            self.error = message(for: error)
        }
    }

    func cancel() {
        context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    private func sharedText() async throws -> String {
        let items = context?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let text = try? await attachmentText(provider, type: .url) { return text }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await attachmentText(provider, type: .plainText) { return text }
        }
        throw ShareError.message("Share a web URL or plain text.")
    }

    private func attachmentText(_ provider: NSItemProvider, type: UTType) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else if type == .url, let url = item as? URL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                    continuation.resume(returning: url.absoluteString)
                } else if type == .plainText, let text = item as? String {
                    continuation.resume(returning: text)
                } else {
                    continuation.resume(throwing: ShareError.message("Share a web URL or plain text."))
                }
            }
        }
    }

    private func request(method: String, body: Data? = nil) async throws -> Data {
        guard let pairing else { throw ShareError.message("Open ChattyPop to pair") }
        // Mirrors COMPANION_PATHS.share in src/shared/companion.ts.
        var request = URLRequest(url: pairing.origin.appendingPathComponent("share"))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("\(SharedPairing.cookieName)=\(pairing.token)", forHTTPHeaderField: "Cookie")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ShareError.message("Can't reach your PC") }
        if response.statusCode == unauthorized { throw ShareError.message("Open ChattyPop to pair") }
        guard successStatuses.contains(response.statusCode) else {
            let failure = try? JSONDecoder().decode(ShareFailure.self, from: data)
            throw ShareError.message(failure?.error ?? "The PC could not complete the request.")
        }
        return data
    }

    private func message(for error: Error) -> String {
        if case ShareError.message(let text) = error { return text }
        if error is URLError { return "Can't reach your PC" }
        if error is SharedPairing.PairingError { return "Open ChattyPop to pair" }
        return "Could not read or send this share. Try again."
    }
}

private struct SharePost: Encodable {
    let channelId: String
    let text: String
}

private struct ShareFailure: Decodable { let error: String }
private enum ShareError: Error { case message(String) }

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct ShareView: View {
    @StateObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Message") { TextEditor(text: $model.text).disabled(model.busy) }
                Section("Channel") {
                    Picker("Send to", selection: $model.channelId) {
                        Text("Choose a channel").tag("")
                        ForEach(model.guilds) { guild in
                            Section(guild.name) {
                                ForEach(guild.channels) { channel in Text(channel.name).tag(channel.id) }
                            }
                        }
                    }.disabled(model.busy)
                }
                if let error = model.error {
                    Section {
                        Text(error)
                        Button("Retry") { Task { await model.load() } }.disabled(model.busy)
                    }
                }
            }
            .navigationTitle("ChattyPop")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: model.cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await model.send() } }.disabled(!model.canSend)
                }
            }
            .task { await model.load() }
        }
    }
}
