import Foundation
import AppKit

/// Drives the visual onboarding wizard in the menu bar app.
/// Mirrors the CLI onboard flow but with a SwiftUI interface.
@MainActor
@Observable
public final class OnboardingViewModel {

    // MARK: - State

    public enum Step: Int, CaseIterable {
        case welcome = 0
        case github = 1
        case telegram = 2
        case starting = 3
        case done = 4
    }

    public enum AuthState {
        case idle
        case waitingForCode(code: String, url: String)
        case validating
        case success
        case failed(String)
    }

    public var currentStep: Step = .welcome
    public var authState: AuthState = .idle
    public var telegramToken: String = ""
    public var telegramBotName: String = ""
    public var telegramSkipped = false
    public var daemonStarted = false
    public var autoStartInstalled = false
    public var errorMessage: String?

    /// True if onboarding has never been completed
    public var needsOnboarding: Bool {
        !FileManager.default.fileExists(atPath: envFilePath)
            || (try? String(contentsOfFile: envFilePath, encoding: .utf8))?.contains("GITHUB_TOKEN") != true
    }

    public var isComplete: Bool { currentStep == .done }

    // MARK: - Paths

    private let homeDir = NSHomeDirectory() + "/.openrappter"
    private var envFilePath: String { homeDir + "/.env" }
    private var configFilePath: String { homeDir + "/config.json" }

    public init() {}

    // MARK: - Step Navigation

    public func advance() {
        guard let next = Step(rawValue: currentStep.rawValue + 1) else { return }
        currentStep = next

        // Auto-run actions for certain steps
        switch next {
        case .starting:
            Task { await startDaemon() }
        default:
            break
        }
    }

    public func skipToChat() {
        currentStep = .done
    }

    // MARK: - GitHub Auth (Device Code Flow)

    public func startGitHubAuth() {
        authState = .validating
        Task {
            // Check for existing token first
            if let existing = existingGitHubToken() {
                saveEnvVar("GITHUB_TOKEN", value: existing)
                authState = .success
                return
            }

            // Start device code flow
            do {
                authState = .waitingForCode(
                    code: "XXXX-XXXX",
                    url: "https://github.com/login/device"
                )

                // Shell out to the CLI onboard device-code helper
                let result = try await runShell(
                    "\(homeDir)/typescript/dist/index.js",
                    args: ["--help"]  // placeholder — real device code would use the copilot-auth module
                )
                _ = result

                // For now, try to use `gh auth token` as the fastest path
                if let ghToken = try? await runShell("/usr/bin/env", args: ["gh", "auth", "token"]) {
                    let token = ghToken.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !token.isEmpty && token.count > 10 {
                        saveEnvVar("GITHUB_TOKEN", value: token)
                        authState = .success
                        return
                    }
                }

                // Open GitHub device flow in browser
                let deviceUrl = "https://github.com/login/device"
                NSWorkspace.shared.open(URL(string: deviceUrl)!)
                authState = .waitingForCode(code: "Check browser", url: deviceUrl)

            } catch {
                authState = .failed(error.localizedDescription)
            }
        }
    }

    /// Quick auth using existing gh CLI or env token
    public func quickAuth() {
        Task {
            authState = .validating
            if let token = existingGitHubToken() {
                saveEnvVar("GITHUB_TOKEN", value: token)
                authState = .success
            } else {
                authState = .failed("No existing token found. Use GitHub login instead.")
            }
        }
    }

    public func saveManualToken(_ token: String) {
        guard !token.isEmpty else { return }
        saveEnvVar("GITHUB_TOKEN", value: token)
        authState = .success
    }

    // MARK: - Telegram

    public func connectTelegram() {
        guard !telegramToken.isEmpty else { return }
        saveEnvVar("TELEGRAM_BOT_TOKEN", value: telegramToken)
        telegramSkipped = false
        // Validate token
        Task {
            if let result = try? await runShell("/usr/bin/env", args: ["curl", "-s", "https://api.telegram.org/bot\(telegramToken)/getMe"]) {
                if result.contains("\"ok\":true"), let nameRange = result.range(of: "\"username\":\"") {
                    let rest = result[nameRange.upperBound...]
                    if let endRange = rest.range(of: "\"") {
                        telegramBotName = "@" + String(rest[..<endRange.lowerBound])
                    }
                }
            }
        }
    }

    public func skipTelegram() {
        telegramSkipped = true
    }

    // MARK: - Start Daemon

    private func startDaemon() async {
        // Check if already running
        let port = 18790
        if isPortOpen(port: port) {
            daemonStarted = true
        } else {
            // Start daemon via shell
            do {
                let nodePath = (try? await runShell("/usr/bin/env", args: ["which", "node"]))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "/opt/homebrew/bin/node"
                let indexPath = homeDir + "/typescript/dist/index.js"

                let process = Process()
                process.executableURL = URL(fileURLWithPath: nodePath)
                process.arguments = [indexPath, "--daemon"]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                process.environment = ProcessInfo.processInfo.environment
                try process.run()

                // Wait for gateway to start
                for _ in 0..<16 {
                    try? await Task.sleep(for: .milliseconds(500))
                    if isPortOpen(port: port) {
                        daemonStarted = true
                        break
                    }
                }
            } catch {
                errorMessage = "Could not start daemon: \(error.localizedDescription)"
            }
        }

        // Install launchd agent
        installLaunchAgent()

        // Save config
        saveConfig()

        // Small delay then advance to done
        try? await Task.sleep(for: .seconds(1))
        currentStep = .done
    }

    // MARK: - Helpers

    private func existingGitHubToken() -> String? {
        // Check env file
        if let envContent = try? String(contentsOfFile: envFilePath, encoding: .utf8) {
            for line in envContent.split(separator: "\n") {
                if line.hasPrefix("GITHUB_TOKEN=") {
                    let token = String(line.dropFirst("GITHUB_TOKEN=".count))
                    if !token.isEmpty { return token }
                }
            }
        }
        // Check env vars
        if let t = ProcessInfo.processInfo.environment["GITHUB_TOKEN"], !t.isEmpty { return t }
        if let t = ProcessInfo.processInfo.environment["GH_TOKEN"], !t.isEmpty { return t }
        // Try gh CLI
        if let result = try? shellSync("gh", args: ["auth", "token"]) {
            let token = result.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty && token.count > 10 { return token }
        }
        return nil
    }

    private func saveEnvVar(_ key: String, value: String) {
        try? FileManager.default.createDirectory(atPath: homeDir, withIntermediateDirectories: true)
        var content = (try? String(contentsOfFile: envFilePath, encoding: .utf8)) ?? ""
        // Remove existing key
        content = content.split(separator: "\n").filter { !$0.hasPrefix("\(key)=") }.joined(separator: "\n")
        if !content.isEmpty { content += "\n" }
        content += "\(key)=\(value)\n"
        try? content.write(toFile: envFilePath, atomically: true, encoding: .utf8)
    }

    private func saveConfig() {
        let config: [String: Any] = [
            "setupComplete": true,
            "copilotAvailable": true,
            "onboardedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: config, options: .prettyPrinted) {
            try? data.write(to: URL(fileURLWithPath: configFilePath))
        }
    }

    private func installLaunchAgent() {
        let plistPath = NSHomeDirectory() + "/Library/LaunchAgents/com.openrappter.daemon.plist"
        let nodePath = (try? shellSync("which", args: ["node"]))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "/opt/homebrew/bin/node"
        let indexPath = homeDir + "/typescript/dist/index.js"
        let logPath = homeDir + "/daemon.log"

        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key><string>com.openrappter.daemon</string>
            <key>ProgramArguments</key><array>
                <string>\(nodePath)</string>
                <string>\(indexPath)</string>
                <string>--daemon</string>
            </array>
            <key>RunAtLoad</key><true/>
            <key>KeepAlive</key><true/>
            <key>StandardOutPath</key><string>\(logPath)</string>
            <key>StandardErrorPath</key><string>\(logPath)</string>
            <key>EnvironmentVariables</key><dict>
                <key>PATH</key><string>\(ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")</string>
                <key>HOME</key><string>\(NSHomeDirectory())</string>
            </dict>
        </dict>
        </plist>
        """

        try? FileManager.default.createDirectory(atPath: (plistPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try? plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
        _ = try? shellSync("launchctl", args: ["load", "-w", plistPath])
        autoStartInstalled = true
    }

    private func isPortOpen(port: Int) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    private func runShell(_ executable: String, args: [String]) async throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    private func shellSync(_ executable: String, args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
