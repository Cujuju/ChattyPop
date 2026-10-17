import Foundation

/// A value fetched outside a lock and kept until invalidated. A fetch an invalidation overtook is returned but not kept: it may
/// predate the change, so the next read fetches again. Sendable through its lock.
final class ShellFetchCache<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: Value?
    /// Raised by each invalidation: a fetch is kept only while this is what it was when the fetch began.
    private var revision = 0

    /// The kept value, else `fetch`'s, run outside the lock (an invalidation may come on its thread) and kept when `keep`.
    func read(keep: Bool, fetch: () -> Value) -> Value {
        let (cached, started) = lock.withLock { (kept, revision) }
        if let cached { return cached }
        let fetched = fetch()
        if keep { lock.withLock { if revision == started { kept = fetched } } }
        return fetched
    }

    /// Drops the kept value, and any fetch already under way.
    func invalidate() {
        lock.withLock {
            kept = nil
            revision += 1
        }
    }
}
