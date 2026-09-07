import Foundation

public enum ShellError: LocalizedError {
    case notFound(String)
    case notExecutable(String, String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let path): return "No such file: \(path)"
        case .notExecutable(let path, let why): return "Cannot execute \(path): \(why)"
        }
    }
}

@MainActor
@Observable
public final class OnboardingViewModel {
    public enum Step: Int, CaseIterable {
        case welcome, github, telegram, starting, done
    }

    public enum AuthState {
        case idle
        case waitingForCode(code: String, url: String)
        case validating
        case success
        case failed(String)
    }

    public private(set) var currentStep: Step = .welcome
    public let authService: GitHubAuthService
    public var telegramToken = ""
    public var telegramBotName = ""
    public var telegramSkipped = false
    public private(set) var daemonStarted = false
    public private(set) var autoStartInstalled = false
    public var wantsAutoStart = false
    public private(set) var isStarting = false
    public private(set) var usingDesktopRuntime = false
    public private(set) var errorMessage: String?

    private let environment: LocalEnvironmentFile
    private let runtime: RuntimePrerequisiteService
    private let autoStartInstaller: () async throws -> Void
    private let setupTimeout: TimeInterval
    private var setupTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var generation: UInt = 0

    public init(
        homeDir: String = NSHomeDirectory() + "/.openrappter",
        launchAgentsDir: String = NSHomeDirectory() + "/Library/LaunchAgents",
        authService: GitHubAuthService? = nil,
        runtime: RuntimePrerequisiteService? = nil
    ) {
        self.authService = authService ?? GitHubAuthService(homeDirectory: homeDir)
        self.runtime = runtime ?? .unconfigured()
        environment = LocalEnvironmentFile(homeDirectory: homeDir)
        setupTimeout = 20 * 60
        autoStartInstaller = {
            try await LaunchAgentManager(launchAgentsDir: launchAgentsDir).setEnabled(
                true, nodePath: "", projectPath: "", port: AppConstants.defaultPort
            )
        }
    }

    init(
        homeDir: String,
        authService: GitHubAuthService,
        runtime: RuntimePrerequisiteService,
        files: CredentialFileAccess,
        setupTimeout: TimeInterval = 60,
        autoStartInstaller: @escaping () async throws -> Void = {}
    ) {
        self.authService = authService
        self.runtime = runtime
        self.setupTimeout = setupTimeout
        self.autoStartInstaller = autoStartInstaller
        environment = LocalEnvironmentFile(homeDirectory: homeDir, files: files)
    }

    public var authState: AuthState {
        if let error = authService.error, authService.authState != .authenticating { return .failed(error) }
        switch authService.authState {
        case .authenticated: return .success
        case .unknown: return .idle
        case .unauthenticated: return .idle
        case .authenticating:
            return authService.userCode.isEmpty
                ? .validating
                : .waitingForCode(code: authService.userCode, url: authService.verificationURL)
        }
    }

    public var needsOnboarding: Bool {
        if runtime.desktopIsAuthoritative || authService.usingGatewayAuthentication { return false }
        return !runtime.hasInstalledRuntime || !authService.hasStoredCredentials
    }

    public var isComplete: Bool { currentStep == .done && daemonStarted }
    public var bootstrapProgress: RuntimeBootstrapProgress? { runtime.bootstrapProgress }

    public func advance() {
        switch currentStep {
        case .welcome:
            if runtime.hasInstalledRuntime { currentStep = .github }
            else { retryRuntimeSetup() }
        case .github:
            guard authService.authState == .authenticated else { return }
            if authService.usingGatewayAuthentication { retryRuntimeSetup() }
            else { currentStep = .telegram }
        case .telegram:
            retryRuntimeSetup()
        case .starting, .done:
            break
        }
    }

    public func skipToChat() {
        generation &+= 1
        let current = generation
        Task {
            let authenticated = await authService.useExistingCredentials().value
            guard current == generation, !Task.isCancelled else { return }
            if authenticated {
                retryRuntimeSetup()
            } else {
                currentStep = .github
            }
        }
    }

    public func startGitHubAuth() { authService.login() }
    public func quickAuth() { authService.useExistingCredentials() }
    public func cancelGitHubAuth() { authService.cancelLogin() }
    public func saveManualToken(_ token: String) { authService.saveManualToken(token) }

    @discardableResult
    public func connectTelegram() -> Bool {
        do {
            guard !authService.usingGatewayAuthentication else {
                throw GitHubAuthError.gatewayFailed("Manage Desktop channels in Settings; its local credentials were not changed.")
            }
            try environment.set("TELEGRAM_BOT_TOKEN", value: telegramToken)
            telegramSkipped = false
            telegramBotName = "Token saved — verify the bot in Settings"
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func skipTelegram() { telegramSkipped = true }

    @discardableResult
    public func retryRuntimeSetup() -> Task<Void, Never> {
        if let setupTask { return setupTask }
        generation &+= 1
        let current = generation
        currentStep = .starting
        isStarting = true
        daemonStarted = false
        autoStartInstalled = false
        errorMessage = nil
        timeoutTask = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: .seconds(setupTimeout)) } catch { return }
            guard current == generation, isStarting else { return }
            cancelRuntimeSetup()
            errorMessage = RuntimePrerequisiteError.timedOut.localizedDescription
        }
        let task = Task {
            defer {
                if current == generation {
                    isStarting = false
                    setupTask = nil
                    timeoutTask?.cancel()
                    timeoutTask = nil
                }
            }
            do {
                let desktop = try await runtime.prepare()
                guard current == generation, !Task.isCancelled else { return }
                usingDesktopRuntime = desktop
                // Either connection mode may have just reconfigured the shared auth service.
                await authService.checkAuthStatus().value
                guard current == generation, !Task.isCancelled else { return }
                guard authService.authState == .authenticated else {
                    currentStep = .github
                    return
                }
                daemonStarted = true
                if wantsAutoStart && !usingDesktopRuntime {
                    try await autoStartInstaller()
                    guard current == generation, !Task.isCancelled else { return }
                    autoStartInstalled = true
                }
                // Completion is live readiness, not a flag in the shared CLI configuration.
                currentStep = .done
            } catch {
                guard current == generation else { return }
                errorMessage = error.localizedDescription
                daemonStarted = false
            }
        }
        setupTask = task
        return task
    }

    public func cancelRuntimeSetup() {
        generation &+= 1
        setupTask?.cancel()
        setupTask = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        isStarting = false
        daemonStarted = false
        errorMessage = "Setup cancelled. No readiness or completion was claimed."
    }

    public func cancel() {
        cancelRuntimeSetup()
        authService.cancelLogin()
    }

}
