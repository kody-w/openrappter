import Foundation

// MARK: - Logs ViewModel

@Observable
@MainActor
public final class LogsViewModel {
    public struct LogEntry: Identifiable, Sendable {
        public let id: String
        public let timestamp: Date
        public let level: String
        public let message: String
        public let source: String?

        public init(id: String = UUID().uuidString, timestamp: Date = Date(), level: String, message: String, source: String? = nil) {
            self.id = id
            self.timestamp = timestamp
            self.level = level
            self.message = message
            self.source = source
        }
    }

    public var logs: [LogEntry] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Actions

    public func loadLogs(limit: Int = 100) {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                let raw = try await rpc.getLogs(limit: limit)
                logs = raw.compactMap { dict -> LogEntry? in
                    guard let message = dict["message"] as? String else { return nil }
                    return LogEntry(
                        timestamp: (dict["timestamp"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date(),
                        level: dict["level"] as? String ?? "info",
                        message: message,
                        source: dict["source"] as? String
                    )
                }
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func clearLogs() {
        logs = []
    }
}
