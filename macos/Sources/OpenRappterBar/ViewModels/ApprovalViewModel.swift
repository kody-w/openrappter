import Foundation

// MARK: - Approval ViewModel

@Observable
@MainActor
public final class ApprovalViewModel {
    public var pendingApprovals: [ExecutionApproval] = []
    public var error: String?

    private var rpcClient: RpcClient?
    private var configurationGeneration: UInt = 0
    private var loadGeneration: UInt = 0
    private var revision: UInt = 0
    private var eventRevisions: [String: UInt] = [:]
    private var resolvedIds: Set<String> = []
    private var resolvedOrder: [String] = []

    public init() {}

    public func configure(rpcClient: RpcClient) {
        configurationGeneration &+= 1
        self.rpcClient = rpcClient
    }

    public func clearConfiguration() {
        configurationGeneration &+= 1
        rpcClient = nil
        pendingApprovals = []
        resolvedIds.removeAll()
        resolvedOrder.removeAll()
        eventRevisions.removeAll()
        error = nil
    }

    var isRpcClientConfigured: Bool {
        rpcClient != nil
    }

    // MARK: - Computed

    public var hasPending: Bool {
        !pendingApprovals.isEmpty
    }

    public var badgeCount: Int {
        pendingApprovals.count
    }

    // MARK: - Actions

    @discardableResult
    public func loadPending() -> Task<Void, Never> {
        guard let rpc = rpcClient else { return Task {} }
        loadGeneration &+= 1
        let load = loadGeneration
        let generation = configurationGeneration
        let startingRevision = revision
        return Task {
            do {
                let response = try await rpc.listPendingApprovals()
                guard generation == configurationGeneration, load == loadGeneration else { return }
                var fetched = response.filter { !resolvedIds.contains($0.id) }
                if startingRevision != revision {
                    let changed = pendingApprovals.filter { (eventRevisions[$0.id] ?? 0) > startingRevision }
                    let currentIds = Set(changed.map(\.id))
                    fetched.removeAll { currentIds.contains($0.id) }
                    fetched += changed
                }
                pendingApprovals = fetched
                let pendingIds = Set(fetched.map(\.id))
                eventRevisions = eventRevisions.filter { pendingIds.contains($0.key) }
                error = nil
            } catch {
                guard generation == configurationGeneration, load == loadGeneration else { return }
                self.error = error.localizedDescription
            }
        }
    }

    public func approve(_ approval: ExecutionApproval) {
        guard let rpc = rpcClient else { return }
        let generation = configurationGeneration
        Task {
            do {
                try await rpc.respondToApproval(approvalId: approval.id, approved: true)
                guard generation == configurationGeneration else { return }
                resolve(approval.id)
            } catch {
                guard generation == configurationGeneration else { return }
                self.error = error.localizedDescription
            }
        }
    }

    public func deny(_ approval: ExecutionApproval) {
        guard let rpc = rpcClient else { return }
        let generation = configurationGeneration
        Task {
            do {
                try await rpc.respondToApproval(approvalId: approval.id, approved: false)
                guard generation == configurationGeneration else { return }
                resolve(approval.id)
            } catch {
                guard generation == configurationGeneration else { return }
                self.error = error.localizedDescription
            }
        }
    }

    // MARK: - Event Handling

    /// Handle an incoming approval request event from the gateway.
    public func handleApprovalEvent(_ payload: [String: Any]) {
        guard let id = payload["id"] as? String,
              let command = payload["command"] as? String else { return }
        guard !resolvedIds.contains(id) else { return }

        let approval = ExecutionApproval(
            id: id,
            command: command,
            description: payload["description"] as? String,
            requestedBy: payload["requestedBy"] as? String,
            sessionKey: payload["sessionKey"] as? String
        )
        if let index = pendingApprovals.firstIndex(where: { $0.id == id }) {
            pendingApprovals[index] = approval
        } else {
            pendingApprovals.append(approval)
        }
        revision &+= 1
        eventRevisions[id] = revision
    }

    private func resolve(_ id: String) {
        pendingApprovals.removeAll { $0.id == id }
        revision &+= 1
        eventRevisions.removeValue(forKey: id)
        error = nil
        if resolvedIds.insert(id).inserted {
            resolvedOrder.append(id)
            if resolvedOrder.count > 256 { resolvedIds.remove(resolvedOrder.removeFirst()) }
        }
    }
}
