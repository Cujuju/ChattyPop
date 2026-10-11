import Foundation
import OSLog

/// A single cookie-less, cache-less session. Its delegate enforces limits as bytes arrive, before buffering them.
final class ShellEmojiDownloader: EmojiDownloader, @unchecked Sendable {
    private static let signposter = OSSignposter(subsystem: "com.cujuju.chattypop", category: "EmojiDownload")
    private let delegate = DownloadDelegate()
    private let session: URLSession

    init(policy: EmojiCachePolicy = EmojiCachePolicy(), configuration: URLSessionConfiguration = .ephemeral) {
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = policy.requestTimeout
        configuration.timeoutIntervalForResource = policy.resourceTimeout
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.cujuju.chattypop.emoji.download"
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    }

    deinit { session.invalidateAndCancel() }

    func download(_ key: EmojiAssetKey, context: EmojiPairingContext, policy: EmojiCachePolicy) async throws -> EmojiAsset {
        let interval = Self.signposter.beginInterval("download")
        defer { Self.signposter.endInterval("download", interval) }
        let cancellation = DownloadCancellation()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                var request = URLRequest(url: context.sourceURL(for: key), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: policy.requestTimeout)
                request.httpShouldHandleCookies = false
                request.setValue(context.cookieHeader, forHTTPHeaderField: "Cookie")
                request.setValue(key.representation.contentType, forHTTPHeaderField: "Accept")
                let task = session.dataTask(with: request)
                delegate.register(task, key: key, limit: max(0, policy.assetBytesMax), continuation: continuation)
                cancellation.install { [delegate] in delegate.finish(task, result: .failure(EmojiLoadFailure.cancelled)); task.cancel() }
                task.resume()
            }
        } onCancel: { cancellation.cancel() }
    }
}

private final class DownloadCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var action: (@Sendable () -> Void)?
    func install(_ action: @escaping @Sendable () -> Void) {
        let run = lock.withLock { () -> Bool in self.action = action; return cancelled }
        if run { action() }
    }
    func cancel() {
        let action = lock.withLock { () -> (@Sendable () -> Void)? in cancelled = true; return self.action }
        action?()
    }
}

private final class DownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct Transfer {
        let key: EmojiAssetKey
        let limit: Int
        let continuation: CheckedContinuation<EmojiAsset, Error>
        var accepted = false
        var bytes = Data()
    }
    private let lock = NSLock()
    private var transfers: [Int: Transfer] = [:]

    func register(_ task: URLSessionTask, key: EmojiAssetKey, limit: Int, continuation: CheckedContinuation<EmojiAsset, Error>) {
        lock.withLock { transfers[task.taskIdentifier] = Transfer(key: key, limit: limit, continuation: continuation) }
    }

    func finish(_ task: URLSessionTask, result: Result<EmojiAsset, Error>) {
        let continuation = lock.withLock { transfers.removeValue(forKey: task.taskIdentifier)?.continuation }
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        finish(task, result: .failure(EmojiLoadFailure.invalidResponse))
        task.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let failure: EmojiLoadFailure? = lock.withLock {
            guard var transfer = transfers[dataTask.taskIdentifier] else { return .cancelled }
            guard let response = response as? HTTPURLResponse,
                  response.url == dataTask.originalRequest?.url else { return .invalidResponse }
            guard response.statusCode == 200 else { return .upstream(status: response.statusCode) }
            guard response.mimeType?.lowercased() == transfer.key.representation.contentType else { return .invalidResponse }
            guard response.expectedContentLength <= Int64(transfer.limit) else { return .tooLarge }
            transfer.accepted = true
            transfers[dataTask.taskIdentifier] = transfer
            return nil
        }
        if let failure {
            completionHandler(.cancel)
            finish(dataTask, result: .failure(failure))
        } else { completionHandler(.allow) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let oversized = lock.withLock { () -> Bool in
            guard var transfer = transfers[dataTask.taskIdentifier], transfer.accepted else { return false }
            guard data.count <= transfer.limit - transfer.bytes.count else { return true }
            transfer.bytes.append(data)
            transfers[dataTask.taskIdentifier] = transfer
            return false
        }
        if oversized {
            finish(dataTask, result: .failure(EmojiLoadFailure.tooLarge))
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let transfer = lock.withLock { transfers.removeValue(forKey: task.taskIdentifier) }
        guard let transfer else { return }
        if let error {
            let failure: EmojiLoadFailure = (error as NSError).code == NSURLErrorCancelled ? .cancelled : .transport
            transfer.continuation.resume(throwing: failure)
        } else if transfer.accepted, transfer.key.representation.validates(transfer.bytes) {
            transfer.continuation.resume(returning: EmojiAsset(data: transfer.bytes, contentType: transfer.key.representation.contentType))
        } else { transfer.continuation.resume(throwing: EmojiLoadFailure.invalidResponse) }
    }
}
