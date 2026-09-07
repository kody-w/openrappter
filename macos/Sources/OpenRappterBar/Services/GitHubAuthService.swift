import AppKit
import Foundation

protocol GatewayAuthenticating {
    func beginGatewayAuthentication() async throws -> GatewayAuthLoginResponse
    func pollGatewayAuthentication(deviceCode: String) async throws -> GatewayAuthPollResponse
    func cancelGatewayAuthentication(deviceCode: String) async throws -> GatewayAuthCancelResponse
    func activeGatewayAuthProfile() async throws -> GatewayAuthProfile?
    func removeGatewayAuthProfile(id: String) async throws
}

extension RpcClient: GatewayAuthenticating {}

@MainActor
struct GitHubAuthDependencies {
    var credentials: any GitHubCredentialStoring
    var request: (URLRequest) async throws -> (Data, HTTPURLResponse)
    var openBrowser: (URL) -> Bool
    var desktopIsAuthoritative: () -> Bool
    var sleep: (TimeInterval) async throws -> Void
    var now: () -> Date
    var maximumLoginDuration: TimeInterval = 900
    var maximumTransportFailures = 3

    static func live(homeDirectory: String) -> Self {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration)
        return Self(
            credentials: GitHubCredentialStore(
                environment: LocalEnvironmentFile(homeDirectory: homeDirectory),
                keychain: SystemGitHubKeychain()
            ),
            request: { request in
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw GitHubAuthError.invalidResponse }
                return (data, http)
            },
            openBrowser: { NSWorkspace.shared.open($0) },
            desktopIsAuthoritative: { DesktopGatewayDiscovery.current() != nil },
            sleep: { try await Task.sleep(for: .seconds($0)) },
            now: Date.init
        )
    }
}

/// One device-code flow for first launch, Settings, and chat recovery.
@Observable
@MainActor
public final class GitHubAuthService {
    public enum AuthState: Equatable {
        case unknown, unauthenticated, authenticating, authenticated
    }

    public private(set) var authState: AuthState = .unknown
    public private(set) var userCode = ""
    public private(set) var verificationURL = ""
    public private(set) var error: String?
    public private(set) var username: String?

    private static let clientId = "Iv1.b507a08c87ecfe98"
    private let dependencies: GitHubAuthDependencies
    private var gateway: (any GatewayAuthenticating)?
    private var generation: UInt = 0
    private var loginTask: Task<Bool, Never>?
    private var statusTask: Task<Void, Never>?
    private var pendingGateway: (code: String, client: any GatewayAuthenticating)?
    private var codeObservers: [(String, String) -> Void] = []

    public init(homeDirectory: String = NSHomeDirectory() + "/.openrappter") {
        dependencies = .live(homeDirectory: homeDirectory)
    }

    init(dependencies: GitHubAuthDependencies, gateway: (any GatewayAuthenticating)? = nil) {
        self.dependencies = dependencies
        self.gateway = gateway
    }

    public var usingGatewayAuthentication: Bool {
        gateway != nil || dependencies.desktopIsAuthoritative()
    }

    public var hasStoredCredentials: Bool {
        (try? dependencies.credentials.hasRuntimeToken()) == true
    }

    public func configure(rpcClient: RpcClient?) {
        configure(gateway: rpcClient)
    }

    func configure(gateway: (any GatewayAuthenticating)?) {
        cancelLogin()
        self.gateway = gateway
        checkAuthStatus()
    }

    @discardableResult
    public func checkAuthStatus() -> Task<Void, Never> {
        cancelLogin()
        let current = generation
        error = nil
        username = nil
        authState = .unknown
        let task = Task {
            do {
                if let gateway {
                    let profile = try await gateway.activeGatewayAuthProfile()
                    guard isCurrent(current) else { return }
                    username = profile?.username ?? profile?.id
                    authState = profile == nil ? .unauthenticated : .authenticated
                } else {
                    try requireLocalAuthority()
                    let identity = try await storedIdentity(generation: current)
                    guard isCurrent(current) else { return }
                    username = identity?.login
                    authState = identity == nil ? .unauthenticated : .authenticated
                }
            } catch {
                guard isCurrent(current) else { return }
                self.error = error.localizedDescription
                authState = .unauthenticated
            }
        }
        statusTask = task
        return task
    }

    @discardableResult
    public func login(onDeviceCode: ((String, String) -> Void)? = nil) -> Task<Bool, Never> {
        if let loginTask {
            if let onDeviceCode {
                codeObservers.append(onDeviceCode)
                if !userCode.isEmpty { onDeviceCode(userCode, verificationURL) }
            }
            return loginTask
        }
        codeObservers = onDeviceCode.map { [$0] } ?? []
        statusTask?.cancel()
        generation &+= 1
        let current = generation
        authState = .authenticating
        error = nil
        username = nil
        userCode = ""
        verificationURL = ""
        let task = Task { () -> Bool in
            defer {
                if current == generation {
                    loginTask = nil
                    codeObservers = []
                }
            }
            do {
                if let gateway {
                    try await loginThroughGateway(gateway, generation: current)
                } else {
                    try requireLocalAuthority()
                    try await loginLocally(generation: current)
                }
                guard isCurrent(current) else { return false }
                error = nil
                userCode = ""
                verificationURL = ""
                authState = .authenticated
                return true
            } catch {
                guard current == generation else { return false }
                authState = .unauthenticated
                if !(error is CancellationError) { self.error = error.localizedDescription }
                userCode = ""
                verificationURL = ""
                if let pending = pendingGateway {
                    pendingGateway = nil
                    await cancelGateway(pending, generation: current)
                }
                return false
            }
        }
        loginTask = task
        return task
    }

    @discardableResult
    public func useExistingCredentials() -> Task<Bool, Never> {
        cancelLogin()
        let current = generation
        authState = .authenticating
        let task = Task { () -> Bool in
            defer { if current == generation { loginTask = nil } }
            do {
                if let gateway {
                    let profile = try await gateway.activeGatewayAuthProfile()
                    guard isCurrent(current) else { return false }
                    guard let profile else { throw GitHubAuthError.gatewayFailed("Sign in through OpenRappter Desktop first.") }
                    username = profile.username ?? profile.id
                } else {
                    try requireLocalAuthority()
                    guard let identity = try await storedIdentity(generation: current) else {
                        throw GitHubAuthError.gatewayFailed("No saved GitHub credential was found. Use GitHub sign-in.")
                    }
                    guard isCurrent(current) else { return false }
                    try requireLocalAuthority()
                    try dependencies.credentials.saveToken(identity.token) {
                        guard isCurrent(current) else { throw CancellationError() }
                        try requireLocalAuthority()
                    }
                    username = identity.login
                }
                authState = .authenticated
                return true
            } catch {
                guard current == generation else { return false }
                self.error = error.localizedDescription
                authState = .unauthenticated
                return false
            }
        }
        loginTask = task
        return task
    }

    @discardableResult
    public func saveManualToken(_ token: String) -> Bool {
        cancelLogin()
        let current = generation
        do {
            try requireLocalAuthority()
            try dependencies.credentials.saveToken(token) {
                guard isCurrent(current) else { throw CancellationError() }
                try requireLocalAuthority()
            }
            error = nil
            authState = .authenticated
            return true
        } catch {
            self.error = error.localizedDescription
            authState = .unauthenticated
            return false
        }
    }

    @discardableResult
    public func cancelLogin() -> Task<Void, Never> {
        generation &+= 1
        let current = generation
        loginTask?.cancel()
        loginTask = nil
        statusTask?.cancel()
        statusTask = nil
        userCode = ""
        verificationURL = ""
        codeObservers = []
        error = nil
        username = nil
        authState = .unauthenticated
        let pending = pendingGateway
        pendingGateway = nil
        return Task {
            if let pending { await cancelGateway(pending, generation: current) }
        }
    }

    @discardableResult
    public func logout() -> Task<Void, Never> {
        let cancellation = cancelLogin()
        let current = generation
        authState = .unknown
        return Task {
            await cancellation.value
            guard isCurrent(current) else { return }
            do {
                if let gateway {
                    if let profile = try await gateway.activeGatewayAuthProfile() {
                        guard isCurrent(current) else { return }
                        try await gateway.removeGatewayAuthProfile(id: profile.id)
                    }
                    let next = try await gateway.activeGatewayAuthProfile()
                    guard isCurrent(current) else { return }
                    username = next?.username ?? next?.id
                    authState = next == nil ? .unauthenticated : .authenticated
                } else {
                    try requireLocalAuthority()
                    try dependencies.credentials.removeToken {
                        guard isCurrent(current) else { throw CancellationError() }
                        try requireLocalAuthority()
                    }
                    username = nil
                    authState = .unauthenticated
                }
            } catch {
                guard isCurrent(current) else { return }
                self.error = error.localizedDescription
                authState = .unknown
            }
        }
    }

    private func loginThroughGateway(_ client: any GatewayAuthenticating, generation current: UInt) async throws {
        let device = try await client.beginGatewayAuthentication()
        guard isCurrent(current) else {
            await cancelGateway((device.deviceCode, client), generation: nil)
            throw CancellationError()
        }
        guard !device.deviceCode.isEmpty else { throw GitHubAuthError.invalidResponse }
        pendingGateway = (device.deviceCode, client)
        try presentCode(device.userCode, url: device.verificationUri)
        let deadline = dependencies.now().addingTimeInterval(dependencies.maximumLoginDuration)
        var failures = 0
        var polls = 0
        while isCurrent(current), dependencies.now() < deadline, polls < 900 {
            polls += 1
            try await dependencies.sleep(1)
            guard isCurrent(current) else { throw CancellationError() }
            let result: GatewayAuthPollResponse
            do {
                result = try await client.pollGatewayAuthentication(deviceCode: device.deviceCode)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failures += 1
                guard failures < dependencies.maximumTransportFailures else {
                    throw GitHubAuthError.gatewayFailed("Desktop authentication is unreachable. Reconnect Desktop and retry.")
                }
                continue
            }
            guard isCurrent(current) else { throw CancellationError() }
            failures = 0
            switch result.status {
            case "pending": continue
            case "success":
                pendingGateway = nil
                username = result.username
                return
            default:
                throw GitHubAuthError.gatewayFailed(result.error ?? "Desktop authentication failed. Please retry.")
            }
        }
        try Task.checkCancellation()
        throw GitHubAuthError.expired
    }

    private func loginLocally(generation current: UInt) async throws {
        let device = try await githubJSON(
            url: "https://github.com/login/device/code",
            form: ["client_id": Self.clientId, "scope": "read:user"]
        )
        guard isCurrent(current) else { throw CancellationError() }
        guard let code = device["device_code"] as? String, !code.isEmpty,
              let userCode = device["user_code"] as? String,
              let url = device["verification_uri"] as? String,
              let expires = device["expires_in"] as? Int, expires > 0 else { throw GitHubAuthError.invalidResponse }
        try presentCode(userCode, url: url)
        let deadline = dependencies.now().addingTimeInterval(min(Double(expires), dependencies.maximumLoginDuration))
        var interval = max(1, min(device["interval"] as? Int ?? 5, 30))
        var polls = 0
        while isCurrent(current), dependencies.now() < deadline, polls < 900 {
            polls += 1
            try await dependencies.sleep(min(Double(interval), max(0, deadline.timeIntervalSince(dependencies.now()))))
            guard isCurrent(current) else { throw CancellationError() }
            guard dependencies.now() < deadline else { break }
            let response = try await githubJSON(
                url: "https://github.com/login/oauth/access_token",
                form: [
                    "client_id": Self.clientId,
                    "device_code": code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                ]
            )
            guard isCurrent(current) else { throw CancellationError() }
            if let token = response["access_token"] as? String, !token.isEmpty {
                try requireLocalAuthority()
                try dependencies.credentials.saveToken(token) {
                    guard isCurrent(current) else { throw CancellationError() }
                    try requireLocalAuthority()
                }
                return
            }
            switch response["error"] as? String {
            case "authorization_pending": continue
            case "slow_down": interval = min(interval + 5, 60)
            case "expired_token": throw GitHubAuthError.expired
            case "access_denied": throw GitHubAuthError.denied
            default: throw GitHubAuthError.invalidResponse
            }
        }
        try Task.checkCancellation()
        throw GitHubAuthError.expired
    }

    private func presentCode(_ code: String, url text: String) throws {
        guard !code.isEmpty, let url = URL(string: text),
              url.scheme == "https", url.host == "github.com",
              url.path == "/login/device", url.user == nil, url.password == nil else {
            throw GitHubAuthError.invalidResponse
        }
        userCode = code
        verificationURL = text
        for observer in codeObservers { observer(code, text) }
        if !dependencies.openBrowser(url) {
            error = "The browser could not open. Open \(text) and enter the code shown here."
        }
    }

    private func githubJSON(url: String, form: [String: String]? = nil, token: String? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: url)!, timeoutInterval: 15)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let form {
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            var components = URLComponents()
            components.queryItems = form.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await dependencies.request(request)
        guard response.statusCode == 200 else { throw GitHubAuthError.requestFailed(response.statusCode) }
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw GitHubAuthError.invalidResponse }
        return result
    }

    private func requireLocalAuthority() throws {
        guard !usingGatewayAuthentication else {
            throw GitHubAuthError.gatewayFailed("OpenRappter Desktop owns sign-in. Reconnect it before authenticating; no local credential was changed.")
        }
    }

    private func storedIdentity(generation current: UInt) async throws -> (token: String, login: String)? {
        guard let primary = try dependencies.credentials.readToken() else { return nil }
        do {
            return (primary, try await storedUsername(primary, generation: current))
        } catch GitHubAuthError.requestFailed(let status) where status == 401 || status == 403 {
            guard isCurrent(current) else { throw CancellationError() }
            try requireLocalAuthority()
            guard let fallback = try dependencies.credentials.fallbackToken(), fallback != primary else {
                throw GitHubAuthError.requestFailed(status)
            }
            return (fallback, try await storedUsername(fallback, generation: current))
        }
    }

    private func storedUsername(_ token: String, generation current: UInt) async throws -> String {
        try requireLocalAuthority()
        let profile = try await githubJSON(url: "https://api.github.com/user", token: token)
        guard isCurrent(current) else { throw CancellationError() }
        try requireLocalAuthority()
        guard let login = profile["login"] as? String, !login.isEmpty else {
            throw GitHubAuthError.invalidResponse
        }
        return login
    }

    private func isCurrent(_ current: UInt) -> Bool {
        current == generation && !Task.isCancelled
    }

    private func cancelGateway(
        _ pending: (code: String, client: any GatewayAuthenticating),
        generation current: UInt?
    ) async {
        for attempt in 0..<dependencies.maximumTransportFailures {
            do {
                let result = try await pending.client.cancelGatewayAuthentication(deviceCode: pending.code)
                guard (result.status == "cancelled" && result.ok)
                        || result.status == "completed"
                        || result.status == "missing" else { throw GitHubAuthError.invalidResponse }
                if result.status != "cancelled", let current, current == generation {
                    let profile = try await pending.client.activeGatewayAuthProfile()
                    guard current == generation else { return }
                    username = profile?.username ?? profile?.id
                    authState = profile == nil ? .unauthenticated : .authenticated
                    if result.status == "completed" {
                        error = "Sign-in had already completed before cancellation. Desktop still owns this account."
                    }
                }
                return
            } catch {
                if attempt + 1 < dependencies.maximumTransportFailures {
                    try? await dependencies.sleep(1)
                }
            }
        }
        if let current, current == generation {
            error = "Desktop sign-in cancellation could not be confirmed. Its device code will expire; reconnect before retrying."
        }
    }
}

enum GitHubAuthError: Error, LocalizedError {
    case requestFailed(Int)
    case invalidResponse
    case expired
    case denied
    case gatewayFailed(String)
    case persistence(String)

    var errorDescription: String? {
        switch self {
        case .requestFailed(let status): return "GitHub request failed (HTTP \(status)). Please retry."
        case .invalidResponse: return "GitHub returned an invalid authentication response."
        case .expired: return "Device code expired — please try again."
        case .denied: return "Login was cancelled or denied."
        case .gatewayFailed(let message), .persistence(let message): return message
        }
    }
}
