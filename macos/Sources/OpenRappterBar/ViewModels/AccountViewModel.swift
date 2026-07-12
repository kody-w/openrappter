import Foundation

// MARK: - Account ViewModel

/// Thin coordinator that owns GitHubAuthService and handles gateway restart after auth.
@Observable
@MainActor
public final class AccountViewModel {
    public let authService = GitHubAuthService()

    private var restartGateway: (() -> Task<Void, Never>)?

    public init() {}

    /// Route authentication restarts through the app's centralized gateway
    /// lifecycle coordinator.
    public func configure(
        restartGateway: @escaping () -> Task<Void, Never>
    ) {
        self.restartGateway = restartGateway
        authService.checkAuthStatus()
    }

    /// Returns the coordinator-owned task so callers can await completion.
    @discardableResult
    public func restartGatewayAfterAuth() -> Task<Void, Never> {
        Log.auth.info("Restarting gateway to pick up new GitHub token")
        return restartGateway?() ?? Task {}
    }
}
