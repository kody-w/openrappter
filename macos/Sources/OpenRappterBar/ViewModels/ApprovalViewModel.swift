import Foundation

// MARK: - Approval ViewModel

@Observable
@MainActor
public final class ApprovalViewModel {
    public var pendingApprovals: [ExecutionApproval] = []
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Computed

    public var hasPending: Bool {
        !pendingApprovals.isEmpty
    }

    public var badgeCount: Int {
        pendingApprovals.count
    }

    // MARK: - Actions

    public func loadPending() {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                pendingApprovals = try await rpc.listPendingApprovals()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func approve(_ approval: ExecutionApproval) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.respondToApproval(approvalId: approval.id, approved: true)
                pendingApprovals.removeAll { $0.id == approval.id }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func deny(_ approval: ExecutionApproval) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.respondToApproval(approvalId: approval.id, approved: false)
                pendingApprovals.removeAll { $0.id == approval.id }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    // MARK: - Event Handling

    /// Handle an incoming approval request event from the gateway.
    public func handleApprovalEvent(_ payload: [String: Any]) {
        guard let id = payload["id"] as? String,
              let command = payload["command"] as? String else { return }

        let approval = ExecutionApproval(
            id: id,
            command: command,
            description: payload["description"] as? String,
            requestedBy: payload["requestedBy"] as? String,
            sessionKey: payload["sessionKey"] as? String
        )
        pendingApprovals.append(approval)
    }
}
