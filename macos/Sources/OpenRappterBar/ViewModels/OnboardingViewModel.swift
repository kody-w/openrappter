import Foundation
import AppKit

/// Why a spawn failed, in words that are true.
///
/// `Process.run()` reports a present-but-not-executable file as
/// `NSCocoaErrorDomain Code=4`, which Foundation renders as
/// `The file "x" doesn't exist.` That message sent a real debugging session
/// looking for a file that was sitting on disk the whole time. These cases are
/// surfaced instead, so the error names the actual problem.
public enum ShellError: LocalizedError {
    case notFound(String)
    case notExecutable(String, String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let path):
            return "No such file: \(path)"
        case .notExecutable(let path, let why):
            return "Cannot execute \(path): \(why)"
        }
    }
}

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

    /// Injectable so the write path can be tested against a temp directory
    /// rather than the real `~/.openrappter`. Defaults to the real one.
    private let homeDir: String
    /// Injectable for the same reason as `homeDir`: the failure path can then
    /// be exercised without writing a real launch agent or calling launchctl.
    private let launchAgentsDir: String
    private var envFilePath: String { homeDir + "/.env" }
    private var configFilePath: String { homeDir + "/config.json" }

    public init(
        homeDir: String = NSHomeDirectory() + "/.openrappter",
        launchAgentsDir: String = NSHomeDirectory() + "/Library/LaunchAgents"
    ) {
        self.homeDir = homeDir
        self.launchAgentsDir = launchAgentsDir
    }

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

            // A placeholder call used to sit here that ran `dist/index.js` as a
            // process executable and discarded the result. It could never
            // succeed: `dist/index.js` is mode 0644 with no shebang — an ESM
            // module, not a program — so `Process.run()` threw NSCocoaErrorDomain
            // Code=4, whose localizedDescription is the untrue string
            // `The file "index.js" doesn't exist.`
            //
            // The lying message was only the visible symptom. The real damage was
            // structural: the throw jumped straight to the catch, so nothing after
            // it ever ran — not the `gh auth token` path, not the browser device
            // flow. A discarded no-op was taking the whole onboarding step down.
            //
            // Deleted rather than repaired: running `--help` and throwing the
            // output away is still a no-op when spelled correctly, and a CLI
            // preflight does not belong inside GitHub authentication. `runNode`
            // below exists so the correct spelling is the easy one when a real
            // call is needed.

            // `gh auth token`, in case the CLI gained a token since the sync check.
            if let ghToken = try? await runShell("/usr/bin/env", args: ["gh", "auth", "token"]) {
                let token = ghToken.trimmingCharacters(in: .whitespacesAndNewlines)
                if !token.isEmpty && token.count > 10 {
                    saveEnvVar("GITHUB_TOKEN", value: token)
                    authState = .success
                    return
                }
            }

            // Hand off to the browser device flow. No fabricated code is shown:
            // the previous version displayed a hardcoded "XXXX-XXXX" while it
            // worked, which is a made-up credential on screen.
            let deviceUrl = "https://github.com/login/device"
            NSWorkspace.shared.open(URL(string: deviceUrl)!)
            authState = .waitingForCode(code: "Check browser", url: deviceUrl)
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
        guard saveEnvVar("GITHUB_TOKEN", value: token) else {
            authState = .failed("Could not write the token to \(envFilePath)")
            return
        }
        authState = .success
    }

    // MARK: - Telegram

    public func connectTelegram() {
        guard !telegramToken.isEmpty else { return }
        guard saveEnvVar("TELEGRAM_BOT_TOKEN", value: telegramToken) else {
            errorMessage = "Could not write the Telegram token to \(envFilePath)"
            return
        }
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
                let nodePath = resolveNodePath()
                // Same resolution the launch agent uses, and for the same
                // reason. This hardcoded `homeDir + "/typescript/dist/index.js"`,
                // where homeDir is ~/.openrappter — the runtime DATA directory,
                // not the code. On a machine where that directory happened to
                // contain an old checkout it started a build that had stopped
                // updating; on one where it does not, `process.run()` throws and
                // onboarding reports "Could not start daemon" on a perfectly good
                // install. `installLaunchAgent` was corrected to ask
                // `resolveProjectPath()`; this, twenty lines above it, was not.
                let projectPath = ProcessManager.resolveProjectPath()
                let nested = projectPath + "/typescript/dist/index.js"
                let root = projectPath + "/dist/index.js"
                let indexPath = FileManager.default.fileExists(atPath: nested) ? nested : root

                let process = Process()
                process.executableURL = URL(fileURLWithPath: nodePath)
                process.arguments = [indexPath, "--daemon"]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                // PATH from `nodeSearchPath()`, not this app's own environment.
                // A Finder-launched menu bar app inherits launchd's session PATH,
                // which is the four-entry one with no node and no copilot in it —
                // the plist below already says so, and the daemon started here
                // was inheriting exactly that for its own children.
                var environment = ProcessInfo.processInfo.environment
                environment["PATH"] = ProcessManager.nodeSearchPath()
                process.environment = environment
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

    /// Write one variable into `~/.openrappter/.env`, preserving the rest.
    ///
    /// Returns `false` if the value did not reach disk, and the caller is
    /// expected to say so rather than report success.
    ///
    /// Two failures were previously indistinguishable from success. The read was
    /// `(try? String(contentsOfFile:)) ?? ""`, so a file that exists and cannot
    /// be decoded produced an empty string, and the rewrite below then replaced
    /// every other variable with just this one. `.env` is shared with the CLI —
    /// `openrappter models set` keeps `OPENRAPPTER_MODEL` there — so that is not
    /// confined to onboarding's own keys. And the write itself was `try?`, so a
    /// failure to save a token looked exactly like saving it.
    ///
    /// The TypeScript `saveEnv` has verified its own read-back since #159. This
    /// does the same thing, for the same reason.
    @discardableResult
    private func saveEnvVar(_ key: String, value: String) -> Bool {
        try? FileManager.default.createDirectory(atPath: homeDir, withIntermediateDirectories: true)

        var content: String
        if FileManager.default.fileExists(atPath: envFilePath) {
            // Present but unreadable is the dangerous case: starting from "" here
            // discards everything already in the file.
            guard let existing = try? String(contentsOfFile: envFilePath, encoding: .utf8) else {
                return false
            }
            content = existing
        } else {
            content = ""
        }

        content = content.split(separator: "\n").filter { !$0.hasPrefix("\(key)=") }.joined(separator: "\n")
        if !content.isEmpty { content += "\n" }
        content += "\(key)=\(value)\n"

        do {
            try content.write(toFile: envFilePath, atomically: true, encoding: .utf8)
        } catch {
            return false
        }

        guard let readBack = try? String(contentsOfFile: envFilePath, encoding: .utf8),
              readBack == content else {
            return false
        }
        return true
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

    /// Internal rather than private so the failure path is reachable from a
    /// test without writing a real launch agent or invoking launchctl.
    func installLaunchAgent() {
        let nodePath = resolveNodePath()
        // Resolve the CODE directory, which is not the data directory.
        //
        // This used to hardcode `homeDir + "/typescript/dist/index.js"`, where
        // homeDir is ~/.openrappter — the runtime DATA dir. That directory also
        // happened to contain an old checkout, so onboarding quietly pinned the
        // daemon to a build that stopped updating months ago while its data half
        // kept being written. Deploys landed in git and never reached the
        // machine. `resolveProjectPath()` already ranks the released build above
        // that directory; it simply was not being asked.
        let projectPath = ProcessManager.resolveProjectPath()
        // A deployed release has dist/ at its root; a source checkout has it
        // under typescript/. `LaunchAgentManager` appends `/dist/index.js`, so
        // hand it whichever base makes that true rather than assuming one.
        let base = FileManager.default.fileExists(atPath: projectPath + "/typescript/dist/index.js")
            ? projectPath + "/typescript"
            : projectPath

        // Onboarding used to write its own plist, at
        // `com.openrappter.daemon.plist`, while `LaunchAgentManager` — which
        // Settings' "Start at login" toggle reads and writes — manages
        // `com.openrappter.gateway.plist`. Two different agents: the toggle
        // showed off after onboarding had just installed one, turning it on
        // added a second job starting the same gateway on the same port, and
        // turning it off could never remove the one onboarding made. The
        // duplicate plist builder is gone; there is one agent now.
        let manager = LaunchAgentManager(launchAgentsDir: launchAgentsDir)
        do {
            try manager.install(nodePath: nodePath, projectPath: base, port: 18790)
        } catch {
            autoStartInstalled = false
            errorMessage = "Could not install auto-start: \(error.localizedDescription)"
            return
        }

        // `launchctl` reports refusal through its exit status, which the Bar's
        // `shellSync` discards along with stderr.
        let status = shellStatus("launchctl", args: ["load", "-w", manager.plistPath])
        guard status == 0 else {
            autoStartInstalled = false
            errorMessage = "Auto-start was written but launchctl refused it (exit \(status)). "
                + "The daemon will not start automatically after a reboot."
            return
        }

        removeLegacyDaemonAgent()
        autoStartInstalled = true
    }

    /// Remove the agent onboarding used to install under its own label.
    ///
    /// Anyone who onboarded before this was unified has a
    /// `com.openrappter.daemon` job that Settings cannot see or remove, still
    /// starting a second gateway on every login.
    private func removeLegacyDaemonAgent() {
        let legacyPath = launchAgentsDir + "/com.openrappter.daemon.plist"
        guard FileManager.default.fileExists(atPath: legacyPath) else { return }
        _ = shellStatus("launchctl", args: ["unload", "-w", legacyPath])
        try? FileManager.default.removeItem(atPath: legacyPath)
    }

    /// Exit status of a command, for the cases where the status is the answer.
    ///
    /// `shellSync` returns stdout and drops the status, which is right for
    /// reading `gh auth token` and wrong for asking whether `launchctl` accepted
    /// something.
    private func shellStatus(_ executable: String, args: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return -1
        }
        process.waitUntilExit()
        return process.terminationStatus
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
        // Foundation lies about this case, and the lie cost real debugging time.
        // Handing `Process` a path that exists but is not executable fails with
        // NSCocoaErrorDomain Code=4, which renders as `The file "x" doesn't
        // exist.` — so the operator goes looking for a missing file that is
        // sitting right there. Check first and say what is actually wrong.
        let fm = FileManager.default
        if executable.hasPrefix("/") {
            var isDir: ObjCBool = false
            if !fm.fileExists(atPath: executable, isDirectory: &isDir) {
                throw ShellError.notFound(executable)
            }
            if isDir.boolValue {
                throw ShellError.notExecutable(executable, "it is a directory")
            }
            if !fm.isExecutableFile(atPath: executable) {
                throw ShellError.notExecutable(
                    executable,
                    "the file exists but has no execute permission — if it is a script, "
                        + "run it through its interpreter instead of as the executable"
                )
            }
        }

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

    /// Find a usable `node`, or fall back to a real path — never to "".
    ///
    /// The obvious spelling of this is a trap that was live on this machine:
    ///
    ///     (try? shellSync("which", args: ["node"]))?.trimming… ?? "/opt/homebrew/bin/node"
    ///
    /// `which node` does not throw when it finds nothing — it exits non-zero with
    /// empty stdout, and the helpers here return "" for that. `??` only fires on
    /// nil, so the fallback never ran and the empty string was used as the
    /// executable. That is how `com.openrappter.daemon.plist` came to be written
    /// with `ProgramArguments[0] = ""`. Same family as the `index.js` defect:
    /// something that is not a program handed to `Process` as one.
    private func resolveNodePath() -> String {
        let found = (try? shellSync("which", args: ["node"]))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !found.isEmpty, FileManager.default.isExecutableFile(atPath: found) { return found }
        for candidate in [
            "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
            NSHomeDirectory() + "/.volta/bin/node",
        ] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return "/opt/homebrew/bin/node"
    }

    /// Run a Node script the way `startDaemon` already does correctly: resolve the
    /// interpreter, then pass the script as its first argument.
    ///
    /// This exists so the executable-vs-script mistake has an obvious right answer
    /// next to it. `dist/index.js` is not a program — it is a module, and every
    /// caller that forgets that gets Foundation's misleading "doesn't exist".
    @discardableResult
    private func runNode(script: String, args: [String] = []) async throws -> String {
        return try await runShell(resolveNodePath(), args: [script] + args)
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
