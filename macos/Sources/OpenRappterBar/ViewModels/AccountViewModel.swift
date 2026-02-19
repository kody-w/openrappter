import Foundation

// MARK: - Account ViewModel

/// Thin coordinator that owns GitHubAuthService and handles gateway restart after auth.
@Observable
@MainActor
public final class AccountViewModel {
    public let authService = GitHubAuthService()

    private var processManager: ProcessManager?
    private var onGatewayRestarted: (() -> Void)?

    public init() {}

    /// Wire up the process manager and callback for gateway restart after auth.
    public func configure(processManager: ProcessManager, onGatewayRestarted: @escaping () -> Void) {
        self.processManager = processManager
        self.onGatewayRestarted = onGatewayRestarted
        authService.checkAuthStatus()
    }

    /// Stop and restart the gateway so it reloads the .env with the new token.
    public func restartGatewayAfterAuth() {
        guard let pm = processManager else { return }
        Task {
            Log.auth.info("Restarting gateway to pick up new GitHub token")
            await pm.stop()
            try? await pm.start()
            onGatewayRestarted?()
        }
    }
}
