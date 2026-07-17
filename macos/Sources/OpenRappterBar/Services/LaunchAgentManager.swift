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
        try preparePrivateLogs()
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
        if isInstalled {
            try fileManager.removeItem(atPath: plistPath)
        }
        let markerPath = NSHomeDirectory()
            + "/.openrappter/gateway-user-agent.enabled"
        if fileManager.fileExists(atPath: markerPath) {
            try fileManager.removeItem(atPath: markerPath)
        }
        Log.app.info("Launch agent removed")
    }

    /// Bootstrap and start the launch agent in the current GUI domain.
    public func load() async throws {
        guard isInstalled else { throw LaunchAgentError.notInstalled }

        let domain = "gui/\(getuid())"
        let target = "\(domain)/\(Self.plistName)"
        guard try runLaunchctl(["bootstrap", domain, plistPath]) == 0 else {
            throw LaunchAgentError.loadFailed
        }
        guard try runLaunchctl(["enable", target]) == 0,
              try runLaunchctl(["kickstart", "-k", target]) == 0 else {
            _ = try? runLaunchctl(["bootout", target])
            throw LaunchAgentError.loadFailed
        }
        Log.app.info("Launch agent loaded")
    }

    /// Boot the launch agent out of the current GUI domain.
    public func unload() async throws {
        let target = "gui/\(getuid())/\(Self.plistName)"
        _ = try? runLaunchctl(["bootout", target])
        Log.app.info("Launch agent unloaded")
    }

    /// Enable or disable the launch agent. Installs/removes the plist and loads/unloads accordingly.
    public func setEnabled(_ enabled: Bool, nodePath: String, projectPath: String, port: Int) async throws {
        let resolvedProjectPath = projectPath.isEmpty
            ? ProcessManager.resolveProjectPath()
            : projectPath
        let resolvedNodePath = nodePath.isEmpty
            ? ProcessManager.resolveNodeExecutable()
            : nodePath
        let entryPoint = (resolvedProjectPath as NSString)
            .appendingPathComponent("dist/index.js")

        if !enabled && (
            resolvedNodePath == nil
            || !fileManager.fileExists(atPath: entryPoint)
        ) {
            try await unload()
            try uninstall()
            return
        }
        guard let resolvedNodePath,
              fileManager.fileExists(atPath: entryPoint) else {
            throw LaunchAgentError.runtimeUnavailable
        }
        let arguments = enabled
            ? [
                entryPoint,
                "service",
                "install",
                "--port",
                String(port),
            ]
            : [entryPoint, "service", "uninstall"]
        do {
            let terminationStatus = try await Task.detached(priority: .userInitiated) {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: resolvedNodePath)
                process.arguments = arguments
                process.currentDirectoryURL = URL(
                    fileURLWithPath: resolvedProjectPath
                )
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus
            }.value
            guard terminationStatus == 0 else {
                throw LaunchAgentError.commandFailed
            }
        } catch {
            if !enabled {
                try await unload()
                try uninstall()
                return
            }
            throw error
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
        let logPath = NSHomeDirectory() + "/.openrappter/logs/gateway.stdout.log"
        let errorLogPath = NSHomeDirectory() + "/.openrappter/logs/gateway.stderr.log"

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
            "ThrottleInterval": 15,
            "ProcessType": "Background",
            "StandardOutPath": logPath,
            "StandardErrorPath": errorLogPath,
            "Umask": 0o077,
            "EnvironmentVariables": [
                "PATH": ProcessManager.nodeSearchPath(),
                "NODE_ENV": "production",
                "HOME": NSHomeDirectory(),
                "OPENRAPPTER_LAUNCHD": "1",
            ] as [String: String],
        ] as [String: Any]
    }

    private func preparePrivateLogs() throws {
        let directory = NSHomeDirectory() + "/.openrappter"
        let logDirectory = directory + "/logs"
        try fileManager.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory
        )
        try fileManager.createDirectory(
            atPath: logDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: logDirectory
        )
        for filename in ["gateway.stdout.log", "gateway.stderr.log"] {
            let path = (logDirectory as NSString).appendingPathComponent(filename)
            try rotateLogIfNeeded(path)
            if !fileManager.fileExists(atPath: path) {
                guard fileManager.createFile(
                    atPath: path,
                    contents: nil,
                    attributes: [.posixPermissions: 0o600]
                ) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            }
            try fileManager.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: path
            )
        }
    }

    private func rotateLogIfNeeded(_ path: String) throws {
        guard fileManager.fileExists(atPath: path),
              let attributes = try? fileManager.attributesOfItem(atPath: path),
              let size = attributes[.size] as? NSNumber,
              size.int64Value >= 5 * 1024 * 1024 else {
            return
        }
        for index in stride(from: 2, through: 1, by: -1) {
            let source = "\(path).\(index)"
            let destination = "\(path).\(index + 1)"
            if fileManager.fileExists(atPath: source) {
                try? fileManager.removeItem(atPath: destination)
                try fileManager.moveItem(atPath: source, toPath: destination)
            }
        }
        try? fileManager.removeItem(atPath: "\(path).1")
        try fileManager.moveItem(atPath: path, toPath: "\(path).1")
    }

    private func runLaunchctl(_ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

// MARK: - Errors

enum LaunchAgentError: Error, LocalizedError {
    case notInstalled
    case loadFailed
    case runtimeUnavailable
    case commandFailed

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Launch agent is not installed"
        case .loadFailed: return "Failed to load launch agent"
        case .runtimeUnavailable: return "OpenRappter compiled runtime is unavailable"
        case .commandFailed: return "OpenRappter service command failed"
        }
    }
}
