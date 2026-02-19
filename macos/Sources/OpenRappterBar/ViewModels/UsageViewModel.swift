import Foundation

// MARK: - Usage ViewModel

@Observable
@MainActor
public final class UsageViewModel {
    public var currentUsage: UsageStats = UsageStats()
    public var recentEntries: [UsageEntry] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Actions

    public func loadUsage() {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                currentUsage = try await rpc.getUsageStats()
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func loadRecentEntries() {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                recentEntries = try await rpc.getUsageHistory()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func refresh() {
        loadUsage()
        loadRecentEntries()
    }
}
