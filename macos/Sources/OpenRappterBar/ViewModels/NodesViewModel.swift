import Foundation

// MARK: - Nodes ViewModel

@Observable
@MainActor
public final class NodesViewModel {
    public var nodes: [Node] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Actions

    public func loadNodes() {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                nodes = try await rpc.listNodes()
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func disconnectNode(_ node: Node) {
        guard let rpc = rpcClient, let connId = node.connectionId else { return }
        Task {
            do {
                try await rpc.disconnectNode(connectionId: connId)
                loadNodes()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func pairNode(host: String, port: Int) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.pairNode(host: host, port: port)
                loadNodes()
            } catch {
                self.error = "Pair failed: \(error.localizedDescription)"
            }
        }
    }
}
