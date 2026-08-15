import AppKit
import Foundation
import Security

// MARK: - GitHub Auth Service

/// Uses Desktop gateway auth when attached, with local OAuth persistence as
/// the standalone fallback.
@Observable
@MainActor
public final class GitHubAuthService {
    // MARK: - Constants

    private static let clientId = "Iv1.b507a08c87ecfe98"
    private static let deviceCodeURL = "https://github.com/login/device/code"
    private static let accessTokenURL = "https://github.com/login/oauth/access_token"
    private static let scope = "read:user"
    private static let keychainService = "com.openrappter.bar"
    private static let keychainAccount = "github_token"

    private static var envFilePath: String {
        NSHomeDirectory() + "/.openrappter/.env"
    }

    // MARK: - State

    public enum AuthState: Equatable {
        case unknown
        case unauthenticated
        case authenticating
        case authenticated
    }

    public var authState: AuthState = .unknown
    public var userCode: String = ""
    public var verificationURL: String = ""
    public var error: String?
    public var username: String?

    private var pollTask: Task<Void, Never>?
    private var rpcClient: RpcClient?
    private var authGeneration: UInt = 0
    private var gatewayDeviceCode: String?
    private var gatewayCancellationTask: Task<Void, Never>?
    private var gatewayCancellationGeneration: UInt = 0

    public var usingGatewayAuthentication: Bool {
        rpcClient != nil
    }

    public func configure(rpcClient: RpcClient?) {
        let previousRpcClient = self.rpcClient
        pollTask?.cancel()
        pollTask = nil
        authGeneration &+= 1
        let generation = authGeneration
        self.rpcClient = rpcClient
        cancelPendingGatewayFlow(
            refreshGeneration: generation,
            preferredRpcClient: previousRpcClient
        )
        refreshAuthStatus(generation: generation)
    }

    // MARK: - Check Auth Status

    /// Check Keychain first, then fall back to .env. Migrates .env token to Keychain if found.
    public func checkAuthStatus() {
        pollTask?.cancel()
        pollTask = nil
        authGeneration &+= 1
        let generation = authGeneration
        cancelPendingGatewayFlow(refreshGeneration: generation)
        refreshAuthStatus(generation: generation)
    }

    private func refreshAuthStatus(generation: UInt) {
        error = nil
        username = nil
        authState = .unknown
        if let rpcClient {
            Task {
                do {
                    let profile = try await rpcClient.activeGatewayAuthProfile()
                    guard generation == authGeneration else { return }
                    username = profile?.username ?? profile?.id
                    authState = profile == nil ? .unauthenticated : .authenticated
                } catch {
                    guard generation == authGeneration else { return }
                    self.error = error.localizedDescription
                    authState = .unauthenticated
                }
            }
            return
        }
        if let token = readKeychain() {
            authState = .authenticated
            fetchUsername(token: token, generation: generation)
            return
        }

        if let token = readTokenFromEnv() {
            // Migrate to Keychain
            saveKeychain(token: token)
            authState = .authenticated
            fetchUsername(token: token, generation: generation)
            return
        }

        authState = .unauthenticated
    }

    // MARK: - Login (Device Code Flow)

    public func login() {
        guard authState != .authenticating, gatewayDeviceCode == nil else { return }
        gatewayCancellationGeneration &+= 1
        gatewayCancellationTask?.cancel()
        gatewayCancellationTask = nil
        pollTask?.cancel()
        authGeneration &+= 1
        let generation = authGeneration
        authState = .authenticating
        error = nil
        userCode = ""
        verificationURL = ""

        if let rpcClient {
            pollTask = Task {
                do {
                    let device = try await rpcClient.beginGatewayAuthentication()
                    guard generation == authGeneration else {
                        cancelDetachedGatewayFlow(
                            deviceCode: device.deviceCode,
                            preferredRpcClient: rpcClient
                        )
                        return
                    }
                    gatewayDeviceCode = device.deviceCode
                    userCode = device.userCode
                    verificationURL = device.verificationUri
                    if let url = URL(string: device.verificationUri) {
                        NSWorkspace.shared.open(url)
                    }
                    while !Task.isCancelled {
                        let result: GatewayAuthPollResponse
                        do {
                            result = try await rpcClient.pollGatewayAuthentication(
                                deviceCode: device.deviceCode
                            )
                        } catch is CancellationError {
                            throw CancellationError()
                        } catch {
                            guard generation == authGeneration else { return }
                            self.error = "Waiting for the Desktop gateway to reconnect…"
                            try await Task.sleep(for: .seconds(1))
                            continue
                        }
                        guard generation == authGeneration else { return }
                        self.error = nil
                        if result.status == "pending" {
                            try await Task.sleep(for: .seconds(1))
                            continue
                        }
                        if result.status == "success" {
                            gatewayDeviceCode = nil
                            username = result.username
                            authState = .authenticated
                            Log.auth.info("Gateway-managed GitHub authentication successful")
                            return
                        }
                        gatewayDeviceCode = nil
                        throw GitHubAuthError.gatewayFailed(
                            result.error ?? "Gateway authentication failed"
                        )
                    }
                } catch is CancellationError {
                    if generation == authGeneration, authState == .authenticating {
                        authState = .unauthenticated
                    }
                } catch {
                    guard generation == authGeneration else { return }
                    self.error = error.localizedDescription
                    authState = .unauthenticated
                }
            }
            return
        }

        pollTask = Task {
            do {
                // Step 1: Request device code
                let deviceResponse = try await requestDeviceCode()
                guard generation == authGeneration else { return }
                userCode = deviceResponse.userCode
                verificationURL = deviceResponse.verificationURI

                // Open browser
                if let url = URL(string: deviceResponse.verificationURI) {
                    NSWorkspace.shared.open(url)
                }

                // Step 2: Poll for access token
                let token = try await pollForAccessToken(
                    deviceCode: deviceResponse.deviceCode,
                    interval: deviceResponse.interval,
                    expiresIn: deviceResponse.expiresIn
                )
                guard generation == authGeneration else { return }

                // Step 3: Persist
                saveKeychain(token: token)
                writeTokenToEnv(token: token)
                authState = .authenticated
                Log.auth.info("GitHub authentication successful")
                fetchUsername(token: token, generation: generation)
            } catch is CancellationError {
                if generation == authGeneration, authState == .authenticating {
                    authState = .unauthenticated
                }
            } catch {
                guard generation == authGeneration else { return }
                Log.auth.error("GitHub auth failed: \(error.localizedDescription)")
                self.error = error.localizedDescription
                authState = .unauthenticated
            }
        }
    }

    // MARK: - Cancel

    public func cancelLogin() {
        authGeneration &+= 1
        let generation = authGeneration
        pollTask?.cancel()
        pollTask = nil
        userCode = ""
        verificationURL = ""
        error = nil
        guard gatewayDeviceCode != nil else {
            authState = .unauthenticated
            return
        }
        authState = .unknown
        cancelPendingGatewayFlow(
            refreshGeneration: generation,
            markCancelled: true
        )
    }

    // MARK: - Logout

    public func logout() {
        cancelPendingGatewayFlow()
        authGeneration &+= 1
        let generation = authGeneration
        pollTask?.cancel()
        pollTask = nil
        if let rpcClient {
            Task {
                do {
                    if let profile = try await rpcClient.activeGatewayAuthProfile() {
                        try await rpcClient.removeGatewayAuthProfile(id: profile.id)
                    }
                    let nextProfile = try await rpcClient.activeGatewayAuthProfile()
                    guard generation == authGeneration else { return }
                    username = nextProfile?.username ?? nextProfile?.id
                    error = nil
                    authState = nextProfile == nil ? .unauthenticated : .authenticated
                } catch {
                    guard generation == authGeneration else { return }
                    self.error = error.localizedDescription
                }
            }
            return
        }
        deleteKeychain()
        removeTokenFromEnv()
        username = nil
        authState = .unauthenticated
        Log.auth.info("GitHub token cleared")
    }

    private func cancelPendingGatewayFlow(
        refreshGeneration: UInt? = nil,
        markCancelled: Bool = false,
        preferredRpcClient: RpcClient? = nil
    ) {
        guard let deviceCode = gatewayDeviceCode else { return }
        gatewayCancellationGeneration &+= 1
        let cancellationGeneration = gatewayCancellationGeneration
        gatewayCancellationTask?.cancel()
        let task = Task {
            var preferredRpcClient = preferredRpcClient
            defer {
                if cancellationGeneration == gatewayCancellationGeneration {
                    gatewayCancellationTask = nil
                }
            }
            while !Task.isCancelled,
                  cancellationGeneration == gatewayCancellationGeneration,
                  gatewayDeviceCode == deviceCode {
                guard let cancellationClient = preferredRpcClient ?? rpcClient else {
                    gatewayDeviceCode = nil
                    if markCancelled, refreshGeneration == authGeneration {
                        authState = .unauthenticated
                        error = "Desktop authentication cancellation could not be confirmed."
                    }
                    return
                }
                preferredRpcClient = nil
                do {
                    let result = try await cancellationClient.cancelGatewayAuthentication(
                        deviceCode: deviceCode
                    )
                    guard cancellationGeneration == gatewayCancellationGeneration,
                          gatewayDeviceCode == deviceCode else { return }
                    gatewayDeviceCode = nil
                    error = nil
                    if let refreshGeneration,
                       refreshGeneration == authGeneration {
                        if markCancelled, result.status == "cancelled" {
                            authState = .unauthenticated
                        } else {
                            refreshAuthStatus(generation: refreshGeneration)
                        }
                    }
                    return
                } catch {
                    if rpcClient == nil {
                        gatewayDeviceCode = nil
                        if markCancelled, refreshGeneration == authGeneration {
                            authState = .unauthenticated
                            self.error = "Desktop authentication cancellation could not be confirmed."
                        }
                        return
                    }
                    if markCancelled, refreshGeneration == authGeneration {
                        self.error = "Cancelling Desktop authentication…"
                    }
                    Log.auth.debug(
                        "Gateway authentication cancellation will retry: \(error.localizedDescription)"
                    )
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        gatewayCancellationTask = task
    }

    private func cancelDetachedGatewayFlow(
        deviceCode: String,
        preferredRpcClient: RpcClient
    ) {
        Task {
            var cancellationClientCandidate: RpcClient? = preferredRpcClient
            while !Task.isCancelled {
                guard let cancellationClient = cancellationClientCandidate ?? rpcClient else {
                    return
                }
                cancellationClientCandidate = nil
                do {
                    _ = try await cancellationClient.cancelGatewayAuthentication(
                        deviceCode: deviceCode
                    )
                    return
                } catch {
                    guard rpcClient != nil else { return }
                    Log.auth.debug(
                        "Detached gateway authentication cancellation will retry: \(error.localizedDescription)"
                    )
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    // MARK: - Device Code Request

    private struct DeviceCodeResponse {
        let deviceCode: String
        let userCode: String
        let verificationURI: String
        let expiresIn: Int
        let interval: Int
    }

    private func requestDeviceCode() async throws -> DeviceCodeResponse {
        var request = URLRequest(url: URL(string: Self.deviceCodeURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let body = "client_id=\(Self.clientId)&scope=\(Self.scope)"
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw GitHubAuthError.deviceCodeFailed(status)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deviceCode = json["device_code"] as? String,
              let userCode = json["user_code"] as? String,
              let verificationURI = json["verification_uri"] as? String,
              let expiresIn = json["expires_in"] as? Int,
              let interval = json["interval"] as? Int else {
            throw GitHubAuthError.invalidResponse
        }

        return DeviceCodeResponse(
            deviceCode: deviceCode,
            userCode: userCode,
            verificationURI: verificationURI,
            expiresIn: expiresIn,
            interval: interval
        )
    }

    // MARK: - Token Polling

    private func pollForAccessToken(deviceCode: String, interval: Int, expiresIn: Int) async throws -> String {
        let expiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        var pollInterval = max(1, interval)

        var request = URLRequest(url: URL(string: Self.accessTokenURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let body = "client_id=\(Self.clientId)&device_code=\(deviceCode)&grant_type=urn:ietf:params:oauth:grant-type:device_code"
        request.httpBody = body.data(using: .utf8)

        while Date() < expiresAt {
            try Task.checkCancellation()
            try await Task.sleep(for: .seconds(pollInterval))
            try Task.checkCancellation()

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                throw GitHubAuthError.tokenRequestFailed(status)
            }

            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw GitHubAuthError.invalidResponse
            }

            if let accessToken = json["access_token"] as? String {
                return accessToken
            }

            let errorCode = json["error"] as? String ?? "unknown"
            switch errorCode {
            case "authorization_pending":
                continue
            case "slow_down":
                pollInterval += 5
                continue
            case "expired_token":
                throw GitHubAuthError.expired
            case "access_denied":
                throw GitHubAuthError.denied
            default:
                let desc = json["error_description"] as? String
                throw GitHubAuthError.other(errorCode, desc)
            }
        }

        throw GitHubAuthError.expired
    }

    // MARK: - Username Fetch

    private func fetchUsername(token: String, generation: UInt) {
        Task {
            do {
                var request = URLRequest(url: URL(string: "https://api.github.com/user")!)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                    return
                }
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let login = json["login"] as? String {
                    guard generation == authGeneration else { return }
                    username = login
                }
            } catch {
                Log.auth.debug("Failed to fetch GitHub username: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Keychain

    private func withoutKeychainInteraction<T>(_ operation: () -> T) -> T {
        var previous = DarwinBoolean(false)
        let hasPreviousState =
            SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess
        SecKeychainSetUserInteractionAllowed(false)
        defer {
            if hasPreviousState {
                SecKeychainSetUserInteractionAllowed(previous.boolValue)
            }
        }
        return operation()
    }

    private func readKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseNoAuthenticationUI as String: true,
        ]
        var result: AnyObject?
        let status = withoutKeychainInteraction {
            SecItemCopyMatching(query as CFDictionary, &result)
        }
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveKeychain(token: String) {
        deleteKeychain() // Remove any existing entry
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
            kSecValueData as String: token.data(using: .utf8)!,
            kSecUseNoAuthenticationUI as String: true,
        ]
        withoutKeychainInteraction {
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    private func deleteKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
            kSecUseNoAuthenticationUI as String: true,
        ]
        withoutKeychainInteraction {
            SecItemDelete(query as CFDictionary)
        }
    }

    // MARK: - .env File

    private func readTokenFromEnv() -> String? {
        guard let data = FileManager.default.contents(atPath: Self.envFilePath),
              let contents = String(data: data, encoding: .utf8) else { return nil }

        for line in contents.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            guard let eqIdx = trimmed.firstIndex(of: "="), eqIdx > trimmed.startIndex else { continue }
            let key = String(trimmed[trimmed.startIndex..<eqIdx]).trimmingCharacters(in: .whitespaces)
            if key == "GITHUB_TOKEN" {
                var val = String(trimmed[trimmed.index(after: eqIdx)...]).trimmingCharacters(in: .whitespaces)
                // Strip surrounding quotes
                if (val.hasPrefix("\"") && val.hasSuffix("\"")) || (val.hasPrefix("'") && val.hasSuffix("'")) {
                    val = String(val.dropFirst().dropLast())
                }
                return val.isEmpty ? nil : val
            }
        }
        return nil
    }

    private func writeTokenToEnv(token: String) {
        let fm = FileManager.default
        let dir = (Self.envFilePath as NSString).deletingLastPathComponent

        // Ensure directory exists
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)

        var lines: [String] = []
        var replaced = false

        if let data = fm.contents(atPath: Self.envFilePath),
           let contents = String(data: data, encoding: .utf8) {
            for line in contents.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty, !trimmed.hasPrefix("#"),
                   let eqIdx = trimmed.firstIndex(of: "="),
                   String(trimmed[trimmed.startIndex..<eqIdx]).trimmingCharacters(in: .whitespaces) == "GITHUB_TOKEN" {
                    lines.append("GITHUB_TOKEN=\"\(token)\"")
                    replaced = true
                } else {
                    lines.append(line)
                }
            }
        }

        if !replaced {
            if lines.isEmpty {
                lines.append("# openrappter environment — managed by `openrappter onboard`")
                lines.append("")
            }
            lines.append("GITHUB_TOKEN=\"\(token)\"")
        }

        let output = lines.joined(separator: "\n")
        try? output.write(toFile: Self.envFilePath, atomically: true, encoding: .utf8)
    }

    private func removeTokenFromEnv() {
        guard let data = FileManager.default.contents(atPath: Self.envFilePath),
              let contents = String(data: data, encoding: .utf8) else { return }

        let lines = contents.components(separatedBy: "\n").filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#"),
                  let eqIdx = trimmed.firstIndex(of: "=") else { return true }
            let key = String(trimmed[trimmed.startIndex..<eqIdx]).trimmingCharacters(in: .whitespaces)
            return key != "GITHUB_TOKEN"
        }

        let output = lines.joined(separator: "\n")
        try? output.write(toFile: Self.envFilePath, atomically: true, encoding: .utf8)
    }
}

// MARK: - Errors

enum GitHubAuthError: Error, LocalizedError {
    case deviceCodeFailed(Int)
    case tokenRequestFailed(Int)
    case invalidResponse
    case expired
    case denied
    case other(String, String?)
    case gatewayFailed(String)

    var errorDescription: String? {
        switch self {
        case .deviceCodeFailed(let status):
            return "GitHub device code request failed (HTTP \(status))"
        case .tokenRequestFailed(let status):
            return "GitHub token request failed (HTTP \(status))"
        case .invalidResponse:
            return "Invalid response from GitHub"
        case .expired:
            return "Device code expired — please try again"
        case .denied:
            return "Login was cancelled or denied"
        case .other(let code, let desc):
            return "GitHub error: \(code)\(desc.map { " — \($0)" } ?? "")"
        case .gatewayFailed(let message):
            return message
        }
    }
}
