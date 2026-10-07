import Network

/// Whether the phone's current route is cellular, reported on the main queue once known and on each change.
final class ShellNetworkMonitor {
    private let monitor = NWPathMonitor()
    /// Nil until the first path arrives.
    private(set) var cellular: Bool?

    func start(_ changed: @escaping (Bool) -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            // Offline counts as not cellular.
            let cellular = path.status == .satisfied && path.usesInterfaceType(.cellular)
            guard let self, self.cellular != cellular else { return }
            self.cellular = cellular
            changed(cellular)
        }
        monitor.start(queue: .main)
    }

    deinit {
        monitor.cancel()
    }
}
