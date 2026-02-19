import Foundation

// MARK: - Sessions ViewModel

@Observable
@MainActor
public final class SessionsViewModel {
    public var sessions: [Session] = []
    public var isLoading: Bool = false

    private var rpcClient: RpcClient?
    private var sessionStore: SessionStore?

    public init() {}

    // MARK: - Configuration

    public func configure(rpcClient: RpcClient, sessionStore: SessionStore) {
        self.rpcClient = rpcClient
        self.sessionStore = sessionStore
    }

    // MARK: - Actions

    /// Load sessions from local cache.
    public func loadCached() {
        Task {
            sessions = await sessionStore?.getSessions() ?? []
        }
    }

    /// Sync sessions from the gateway.
    public func syncFromGateway() {
        guard let rpc = rpcClient else { return }
        isLoading = true

        Task {
            do {
                let gatewaySessions = try await rpc.listSessions()
                await sessionStore?.syncFromGateway(sessions: gatewaySessions)
                sessions = await sessionStore?.getSessions() ?? []
            } catch {
                // Fall back to cached sessions
                sessions = await sessionStore?.getSessions() ?? []
            }
            isLoading = false
        }
    }

    /// Delete a session.
    public func deleteSession(_ session: Session) {
        guard let rpc = rpcClient else { return }

        Task {
            do {
                try await rpc.deleteSession(sessionKey: session.sessionKey)
            } catch {
                // Continue with local deletion even if gateway fails
            }
            await sessionStore?.deleteSession(sessionKey: session.sessionKey)
            sessions = await sessionStore?.getSessions() ?? []
        }
    }

    /// Reset a session (clear messages but keep session).
    public func resetSession(_ session: Session) {
        guard let rpc = rpcClient else { return }

        Task {
            do {
                try await rpc.resetSession(sessionKey: session.sessionKey)
            } catch {
                // Continue with local reset
            }
            await sessionStore?.clearMessages(sessionKey: session.sessionKey)
            sessions = await sessionStore?.getSessions() ?? []
        }
    }
}
