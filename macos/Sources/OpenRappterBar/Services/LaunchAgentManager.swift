import Foundation

// MARK: - Launch Agent Manager

/// Manages a launchd plist at ~/Library/LaunchAgents/ for auto-starting the gateway on login.
@MainActor
public final class LaunchAgentManager {
    public static let plistName = "com.openrappter.gateway"
    public static let plistFilename = "\(plistName).plist"

    private let fileManager = FileManager.default

    public init() {}

    // MARK: - Public API

    /// Whether the launch agent plist currently exists.
    public var isInstalled: Bool {
        fileManager.fileExists(atPath: plistPath)
    }

    /// Install the launch agent plist to auto-start the gateway on login.
    public func install(nodePath: String, projectPath: String, port: Int) throws {
        let plist = buildPlist(nodePath: nodePath, projectPath: projectPath, port: port)
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)

        // Ensure LaunchAgents directory exists
        let dir = launchAgentsDir
        if !fileManager.fileExists(atPath: dir) {
            try fileManager.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }

        try data.write(to: URL(fileURLWithPath: plistPath))
        Log.app.info("Launch agent installed at \(self.plistPath)")
    }

    /// Remove the launch agent plist.
    public func uninstall() throws {
        guard isInstalled else { return }
        try fileManager.removeItem(atPath: plistPath)
        Log.app.info("Launch agent removed")
    }

    /// Load (start) the launch agent via launchctl.
    public func load() async throws {
        guard isInstalled else { throw LaunchAgentError.notInstalled }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["load", plistPath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            throw LaunchAgentError.loadFailed
        }
        Log.app.info("Launch agent loaded")
    }

    /// Unload (stop) the launch agent via launchctl.
    public func unload() async throws {
        guard isInstalled else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["unload", plistPath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()
        // Don't check exit status — unload may fail if already unloaded
        Log.app.info("Launch agent unloaded")
    }

    /// Enable or disable the launch agent. Installs/removes the plist and loads/unloads accordingly.
    public func setEnabled(_ enabled: Bool, nodePath: String, projectPath: String, port: Int) async throws {
        if enabled {
            try install(nodePath: nodePath, projectPath: projectPath, port: port)
            try await load()
        } else {
            try await unload()
            try uninstall()
        }
    }

    // MARK: - Private

    private var launchAgentsDir: String {
        NSHomeDirectory() + "/Library/LaunchAgents"
    }

    private var plistPath: String {
        launchAgentsDir + "/" + Self.plistFilename
    }

    private func buildPlist(nodePath: String, projectPath: String, port: Int) -> [String: Any] {
        let logPath = NSHomeDirectory() + "/.openrappter/gateway.log"
        let errorLogPath = NSHomeDirectory() + "/.openrappter/gateway-error.log"

        return [
            "Label": Self.plistName,
            "ProgramArguments": [
                nodePath,
                projectPath + "/dist/index.js",
                "--daemon",
                "--port", String(port),
            ],
            "WorkingDirectory": projectPath,
            "RunAtLoad": true,
            "KeepAlive": [
                "SuccessfulExit": false,  // Restart only on crash, not clean exit
            ] as [String: Any],
            "StandardOutPath": logPath,
            "StandardErrorPath": errorLogPath,
            "EnvironmentVariables": [
                "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
                "NODE_ENV": "production",
            ] as [String: String],
        ] as [String: Any]
    }
}

// MARK: - Errors

enum LaunchAgentError: Error, LocalizedError {
    case notInstalled
    case loadFailed

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Launch agent is not installed"
        case .loadFailed: return "Failed to load launch agent"
        }
    }
}
