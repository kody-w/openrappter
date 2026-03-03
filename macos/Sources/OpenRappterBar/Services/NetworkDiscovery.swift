import Foundation
import Network

// MARK: - Network Discovery

/// Discovers OpenRappter gateway instances on the local network via Bonjour.
@MainActor
public final class NetworkDiscovery {
    public struct DiscoveredGateway: Identifiable, Sendable {
        public let id: String
        public let name: String
        public let host: String
        public let port: Int

        public init(id: String = UUID().uuidString, name: String, host: String, port: Int) {
            self.id = id
            self.name = name
            self.host = host
            self.port = port
        }
    }

    private static let serviceType = "_openrappter._tcp"

    public var discoveredGateways: [DiscoveredGateway] = []
    public var isSearching: Bool = false

    private var browser: NWBrowser?

    public init() {}

    // MARK: - Discovery

    /// Start browsing for OpenRappter gateways on the network.
    public func startDiscovery() {
        guard !isSearching else { return }

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: params)

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready:
                    self?.isSearching = true
                case .failed, .cancelled:
                    self?.isSearching = false
                default:
                    break
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                self?.handleResults(results)
            }
        }

        browser.start(queue: .main)
        self.browser = browser
        Log.app.info("Network discovery started for \(Self.serviceType)")
    }

    /// Stop browsing.
    public func stopDiscovery() {
        browser?.cancel()
        browser = nil
        isSearching = false
        discoveredGateways = []
        Log.app.info("Network discovery stopped")
    }

    // MARK: - Port Check

    /// Check if a specific port is in use on localhost.
    public static func isPortInUse(_ port: Int) async -> Bool {
        let connection = NWConnection(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(integerLiteral: UInt16(port)),
            using: .tcp
        )

        return await withCheckedContinuation { continuation in
            // Guard against double-resume (timeout + state change race)
            let resumed = UnsafeMutablePointer<Bool>.allocate(capacity: 1)
            resumed.initialize(to: false)

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.cancel()
                    if !resumed.pointee {
                        resumed.pointee = true
                        continuation.resume(returning: true)
                    }
                case .failed, .cancelled:
                    if !resumed.pointee {
                        resumed.pointee = true
                        continuation.resume(returning: false)
                    }
                default:
                    break
                }
            }
            connection.start(queue: .global())

            // Timeout after 1 second
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) {
                connection.cancel()
                if !resumed.pointee {
                    resumed.pointee = true
                    continuation.resume(returning: false)
                }
                resumed.deinitialize(count: 1)
                resumed.deallocate()
            }
        }
    }

    // MARK: - Private

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        discoveredGateways = results.compactMap { result in
            guard case .service(let name, _, _, _) = result.endpoint else { return nil }
            // We'll resolve the actual host/port when the user selects one
            return DiscoveredGateway(
                name: name,
                host: "local",
                port: AppConstants.defaultPort
            )
        }
    }
}
