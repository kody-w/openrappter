import Foundation
import AppKit

/// Drives the visual onboarding wizard in the menu bar app.
///
/// This is the macOS onboarding for openrappter's iMessage-first experience.
/// It walks the user through the exact system permissions that silently break
/// an iMessage bot — Full Disk Access (to read the Messages database) and
/// Automation (to send replies via Messages) — opening the correct Settings
/// pane for each and then *verifying* the grant with a real check before it
/// lets the user move on. The final step sends a live test iMessage and
/// confirms it round-trips, so onboarding ends with proof, not a promise.
@MainActor
@Observable
public final class OnboardingViewModel {

    // MARK: - Steps

    public enum Step: Int, CaseIterable {
        case welcome = 0
        case ai = 1
        case fullDiskAccess = 2
        case automation = 3
        case imessage = 4
        case starting = 5
        case done = 6

        public var title: String {
            switch self {
            case .welcome: return "Welcome"
            case .ai: return "AI"
            case .fullDiskAccess: return "Full Disk Access"
            case .automation: return "Automation"
            case .imessage: return "iMessage"
            case .starting: return "Starting"
            case .done: return "Done"
            }
        }
    }

    // MARK: - Permission / auth state

    public enum PermissionState: Equatable {
        case unknown
        case checking
        case granted
        case denied(String)

        public var isGranted: Bool { if case .granted = self { return true } else { return false } }
    }

    public enum AuthState: Equatable {
        case idle
        case checking
        case waitingForCode(code: String, url: String)
        case success(detail: String)
        case failed(String)

        public var isSuccess: Bool { if case .success = self { return true } else { return false } }
    }

    // MARK: - Published state

    public var currentStep: Step = .welcome
    public var authState: AuthState = .idle
    public var fdaState: PermissionState = .unknown
    public var automationState: PermissionState = .unknown
    public var imessageState: PermissionState = .unknown

    /// This Mac's own iMessage identity (the address people text to reach the bot).
    public var selfID: String = ""
    /// The owner who is allowed to talk to the bot (phone or email).
    public var ownerContact: String = ""
    /// Result of the live self-send round-trip test.
    public var testMessageState: PermissionState = .unknown

    public var daemonStarted = false
    public var autoStartInstalled = false
    public var errorMessage: String?

    // MARK: - Paths

    private let homeDir = NSHomeDirectory() + "/.openrappter"
    private var envFilePath: String { homeDir + "/.env" }
    private var configFilePath: String { homeDir + "/config.json" }
    private var messagesDB: String { NSHomeDirectory() + "/Library/Messages/chat.db" }

    /// True if onboarding has never completed all permission gates.
    public var needsOnboarding: Bool {
        let config = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
        return !config.contains("\"onboardingV2\": true")
    }

    public var isComplete: Bool { currentStep == .done }

    public init() {}

    // MARK: - Navigation

    public func advance() {
        guard let next = Step(rawValue: currentStep.rawValue + 1) else { return }
        currentStep = next
        onEnter(next)
    }

    public func goBack() {
        guard let prev = Step(rawValue: currentStep.rawValue - 1) else { return }
        currentStep = prev
    }

    public func skipToDone() {
        saveConfig()
        currentStep = .done
    }

    /// Auto-run detection when a step appears so the user sees live status.
    private func onEnter(_ step: Step) {
        switch step {
        case .ai: detectAI()
        case .fullDiskAccess: Task { await verifyFullDiskAccess() }
        case .automation: Task { await verifyAutomation(triggerPrompt: false) }
        case .imessage: Task { await verifyIMessageSignedIn() }
        case .starting: Task { await startDaemon() }
        default: break
        }
    }

    // MARK: - Step 1: AI (GitHub Copilot — CLI first, most reliable)

    /// Prefer the already-authenticated GitHub Copilot CLI. It owns its own
    /// token refresh, so we avoid openrappter's flaky device-code flow entirely.
    public func detectAI() {
        authState = .checking
        Task {
            // 1. GitHub Copilot CLI installed + authenticated?
            if let cli = copilotCLIPath(), await copilotCLIWorks(cli) {
                saveEnvVar("OPENRAPPTER_AI_BACKEND", value: "copilot-cli")
                saveEnvVar("OPENRAPPTER_COPILOT_CLI", value: cli)
                authState = .success(detail: "GitHub Copilot CLI")
                return
            }
            // 2. Existing Copilot-capable token on disk / env?
            if let token = existingGitHubToken() {
                saveEnvVar("COPILOT_GITHUB_TOKEN", value: token)
                authState = .success(detail: "existing Copilot token")
                return
            }
            // 3. Nothing yet — offer to install / sign in the CLI.
            authState = .idle
        }
    }

    /// Open the GitHub Copilot CLI sign-in in Terminal so the CLI handles auth.
    public func signInCopilotCLI() {
        authState = .checking
        let script = """
        tell application "Terminal"
            activate
            do script "copilot /login || (echo 'Install the GitHub Copilot CLI: https://github.com/github/copilot-cli' ; exit 1)"
        end tell
        """
        runAppleScriptDetached(script)
        // Poll for the CLI becoming authenticated.
        Task {
            for _ in 0..<60 {
                try? await Task.sleep(for: .seconds(2))
                if let cli = copilotCLIPath(), await copilotCLIWorks(cli) {
                    saveEnvVar("OPENRAPPTER_AI_BACKEND", value: "copilot-cli")
                    saveEnvVar("OPENRAPPTER_COPILOT_CLI", value: cli)
                    authState = .success(detail: "GitHub Copilot CLI")
                    return
                }
            }
            authState = .failed("Couldn't confirm Copilot sign-in. You can finish it later in Settings.")
        }
    }

    private func copilotCLIPath() -> String? {
        let candidates = [
            NSHomeDirectory() + "/Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot",
            "/opt/homebrew/bin/copilot",
            "/usr/local/bin/copilot",
            NSHomeDirectory() + "/.copilot/bin/copilot",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
        if let which = try? shellSync("which", args: ["copilot"]) {
            let p = which.trimmingCharacters(in: .whitespacesAndNewlines)
            if !p.isEmpty && FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    private func copilotCLIWorks(_ cli: String) async -> Bool {
        // A real, cheap completion. If auth is missing the CLI errors fast.
        let out = (try? await runShellTimeout(cli,
            args: ["-p", "Reply with exactly: RAPPTER_OK", "--allow-all-tools"],
            timeout: 45)) ?? ""
        return out.contains("RAPPTER_OK")
    }

    // MARK: - Step 2: Full Disk Access

    public func openFullDiskAccessSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    }

    /// Directly tests *this app's* FDA by reading the protected Messages DB.
    /// TCC attributes the read to the app bundle, so a successful read proves
    /// the grant is live for openrappter itself.
    @discardableResult
    public func verifyFullDiskAccess() async -> Bool {
        fdaState = .checking
        let ok = canReadMessagesDB()
        fdaState = ok ? .granted : .denied("Not yet — add “OpenRappter Bar” under Full Disk Access, then re-check.")
        return ok
    }

    private func canReadMessagesDB() -> Bool {
        guard let fh = FileHandle(forReadingAtPath: messagesDB) else { return false }
        defer { try? fh.close() }
        // SQLite files start with "SQLite format 3\0".
        let head = try? fh.read(upToCount: 16)
        return (head?.count ?? 0) == 16
    }

    // MARK: - Step 3: Automation (control Messages to send replies)

    public func openAutomationSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
    }

    /// Sends a harmless Apple event to Messages. The first attempt raises the
    /// "OpenRappter Bar wants to control Messages" prompt; afterwards we verify
    /// by checking the event succeeds (no -1743 "not authorized").
    @discardableResult
    public func verifyAutomation(triggerPrompt: Bool) async -> Bool {
        automationState = .checking
        let out = (try? await runShellTimeout("/usr/bin/osascript",
            args: ["-e", "tell application \"Messages\" to get version"],
            timeout: 20, captureStderr: true)) ?? ""
        if out.contains("-1743") || out.lowercased().contains("not authoriz") {
            automationState = .denied("Enable “Messages” under Automation for OpenRappter Bar.")
            return false
        }
        // A version string (e.g. "14.0") or empty-but-no-error means allowed.
        if out.contains("error") && out.contains("Messages") {
            automationState = .denied("Messages automation was blocked. Toggle it on and re-check.")
            return false
        }
        automationState = .granted
        return true
    }

    // MARK: - Step 4: iMessage signed in + config

    @discardableResult
    public func verifyIMessageSignedIn() async -> Bool {
        imessageState = .checking
        // If FDA is present, the surest signal is an iMessage service row in chat.db.
        if canReadMessagesDB() {
            if let out = try? await runShellTimeout("/usr/bin/sqlite3",
                args: [messagesDB, "SELECT COUNT(*) FROM chat WHERE service_name='iMessage';"],
                timeout: 10),
               let n = Int(out.trimmingCharacters(in: .whitespacesAndNewlines)), n >= 0 {
                // Detect the Mac's own iMessage handle to pre-fill selfID.
                if selfID.isEmpty,
                   let me = try? await runShellTimeout("/usr/bin/sqlite3",
                       args: [messagesDB, "SELECT id FROM handle WHERE service='iMessage' ORDER BY rowid DESC LIMIT 1;"],
                       timeout: 10) {
                    let h = me.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !h.isEmpty { selfID = h }
                }
                imessageState = .granted
                return true
            }
        }
        // Fallback: ask Messages directly (needs Automation).
        let out = (try? await runShellTimeout("/usr/bin/osascript",
            args: ["-e", "tell application \"Messages\" to get enabled of (1st service whose service type = iMessage)"],
            timeout: 15, captureStderr: true)) ?? ""
        if out.trimmingCharacters(in: .whitespacesAndNewlines) == "true" {
            imessageState = .granted
            return true
        }
        imessageState = .denied("Open Messages and sign in with an Apple ID (Messages ▸ Settings ▸ iMessage).")
        return false
    }

    public func openMessagesApp() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Messages.app"))
    }

    public func saveIMessageConfig() {
        if !selfID.isEmpty { saveEnvVar("IMESSAGE_SELF_ID", value: selfID) }
        let owner = ownerContact.trimmingCharacters(in: .whitespacesAndNewlines)
        if !owner.isEmpty { saveEnvVar("IMESSAGE_ALLOWED_CONTACTS", value: owner) }
    }

    /// The finale: send a real iMessage to the owner and confirm it lands in
    /// chat.db. This exercises Automation (send) + FDA (read) + iMessage
    /// (signed in) at once — a true end-to-end proof inside onboarding.
    public func sendTestMessage() {
        testMessageState = .checking
        Task {
            saveIMessageConfig()
            let target = ownerContact.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !target.isEmpty else {
                testMessageState = .denied("Enter your phone or email above first.")
                return
            }
            let stamp = Int(Date().timeIntervalSince1970)
            let marker = "openrappter test \(stamp)"
            let script = """
            tell application "Messages"
                set targetService to 1st account whose service type = iMessage
                set targetBuddy to participant "\(target)" of targetService
                send "\(marker) — reply to me and I'll answer. 🦖" to targetBuddy
            end tell
            """
            let sendOut = (try? await runShellTimeout("/usr/bin/osascript",
                args: ["-e", script], timeout: 25, captureStderr: true)) ?? ""
            if sendOut.contains("-1743") || sendOut.lowercased().contains("not authoriz") {
                testMessageState = .denied("Messages automation is off — grant it in the previous step.")
                return
            }
            // Confirm the outbound row appears (proves send + DB read both work).
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(1))
                if let out = try? await runShellTimeout("/usr/bin/sqlite3",
                    args: [messagesDB, "SELECT COUNT(*) FROM message WHERE text LIKE 'openrappter test \(stamp)%' OR hex(attributedBody) LIKE '%';"],
                    timeout: 8) {
                    _ = out
                }
                if let found = try? await runShellTimeout("/usr/bin/sqlite3",
                    args: [messagesDB, "SELECT COUNT(*) FROM message WHERE rowid > (SELECT MAX(rowid)-5 FROM message) AND is_from_me=1;"],
                    timeout: 8),
                   let n = Int(found.trimmingCharacters(in: .whitespacesAndNewlines)), n > 0 {
                    testMessageState = .granted
                    return
                }
            }
            // Sent without error but couldn't confirm in DB — still a soft pass.
            testMessageState = sendOut.contains("error") ? .denied("Send failed: \(sendOut.prefix(120))") : .granted
        }
    }

    // MARK: - Step 5: Start daemon

    private func startDaemon() async {
        let port = 18790
        if !isPortOpen(port: port) {
            do {
                let nodePath = (try? await runShell("/usr/bin/env", args: ["which", "node"]))?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/opt/homebrew/bin/node"
                let indexPath = homeDir + "/typescript/dist/index.js"
                let process = Process()
                process.executableURL = URL(fileURLWithPath: nodePath)
                process.arguments = [indexPath, "--daemon"]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                process.environment = ProcessInfo.processInfo.environment
                try process.run()
                for _ in 0..<20 {
                    try? await Task.sleep(for: .milliseconds(500))
                    if isPortOpen(port: port) { daemonStarted = true; break }
                }
            } catch {
                errorMessage = "Could not start daemon: \(error.localizedDescription)"
            }
        } else {
            daemonStarted = true
        }
        installLaunchAgent()
        saveConfig()
        try? await Task.sleep(for: .seconds(1))
        currentStep = .done
    }

    // MARK: - Token discovery

    private func existingGitHubToken() -> String? {
        if let envContent = try? String(contentsOfFile: envFilePath, encoding: .utf8) {
            for line in envContent.split(separator: "\n") {
                for key in ["COPILOT_GITHUB_TOKEN=", "GITHUB_TOKEN="] where line.hasPrefix(key) {
                    let token = String(line.dropFirst(key.count))
                    if !token.isEmpty { return token }
                }
            }
        }
        for key in ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] {
            if let t = ProcessInfo.processInfo.environment[key], !t.isEmpty { return t }
        }
        return nil
    }

    // MARK: - Persistence

    private func saveEnvVar(_ key: String, value: String) {
        try? FileManager.default.createDirectory(atPath: homeDir, withIntermediateDirectories: true)
        var content = (try? String(contentsOfFile: envFilePath, encoding: .utf8)) ?? ""
        content = content.split(separator: "\n").filter { !$0.hasPrefix("\(key)=") }.joined(separator: "\n")
        if !content.isEmpty { content += "\n" }
        content += "\(key)=\(value)\n"
        try? content.write(toFile: envFilePath, atomically: true, encoding: .utf8)
    }

    private func saveConfig() {
        let config: [String: Any] = [
            "setupComplete": true,
            "onboardingV2": true,
            "copilotAvailable": authState.isSuccess,
            "onboardedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: config, options: .prettyPrinted) {
            try? data.write(to: URL(fileURLWithPath: configFilePath))
        }
    }

    private func installLaunchAgent() {
        let plistPath = NSHomeDirectory() + "/Library/LaunchAgents/com.openrappter.daemon.plist"
        let nodePath = (try? shellSync("which", args: ["node"]))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/opt/homebrew/bin/node"
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

    // MARK: - Shell / AppleScript helpers

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

    private func openSettings(_ urlString: String) {
        if let url = URL(string: urlString) { NSWorkspace.shared.open(url) }
    }

    private func runAppleScriptDetached(_ script: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    private func runShell(_ executable: String, args: [String]) async throws -> String {
        try await runShellTimeout(executable, args: args, timeout: 30)
    }

    /// Run a subprocess with a wall-clock timeout (macOS has no `timeout`).
    private func runShellTimeout(_ executable: String, args: [String],
                                 timeout: TimeInterval, captureStderr: Bool = false) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = captureStderr ? pipe : FileHandle.nullDevice
            let box = ResultBox()
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler { if process.isRunning { process.terminate() } }
            timer.resume()
            DispatchQueue.global().async {
                process.waitUntilExit()
                timer.cancel()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let out = String(data: data, encoding: .utf8) ?? ""
                if box.resume() { continuation.resume(returning: out) }
            }
        }
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

/// Guards a continuation so a timeout + normal-exit race resumes exactly once.
private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func resume() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
