import Foundation

// MARK: - Process Manager

/// Manages the lifecycle of the OpenRappter gateway node process.
@MainActor
public final class ProcessManager: Observable {
    public enum ProcessState: String, Sendable {
        case stopped
        case starting
        case running
        case stopping
    }

    public private(set) var state: ProcessState = .stopped
    private var process: Process?
    private let port: Int

    public init(port: Int = 18790) {
        self.port = port
    }

    /// Resolve the path to the TypeScript project root.
    public var projectPath: String {
        // 1. OPENRAPPTER_PATH env var
        if let envPath = ProcessInfo.processInfo.environment["OPENRAPPTER_PATH"] {
            return envPath
        }

        // 2. ~/.openrappter/config.json
        let configPath = NSHomeDirectory() + "/.openrappter/config.json"
        if FileManager.default.fileExists(atPath: configPath),
           let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = json["projectPath"] as? String {
            return path
        }

        // 3. Relative to executable (assuming macos/ is sibling to typescript/)
        let execURL = Bundle.main.executableURL ?? URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
        let projectRoot = execURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return projectRoot.appendingPathComponent("typescript").path
    }

    /// Start the gateway process.
    public func start() async throws {
        guard state == .stopped else { return }
        state = .starting

        let tsPath = projectPath
        let nodePath = resolveNodePath()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["dist/index.js", "--daemon", "--port", String(port)]
        proc.currentDirectoryURL = URL(fileURLWithPath: tsPath)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            self.process = proc

            // Poll /health until ready (up to 15s)
            let ready = await pollHealth(maxWait: 15)
            if ready {
                state = .running
            } else {
                // Process started but health check failed
                proc.terminate()
                self.process = nil
                state = .stopped
                throw ProcessManagerError.healthCheckFailed
            }
        } catch let error as ProcessManagerError {
            state = .stopped
            throw error
        } catch {
            state = .stopped
            throw ProcessManagerError.launchFailed(error.localizedDescription)
        }
    }

    /// Stop the gateway process.
    public func stop() async {
        guard let proc = process, proc.isRunning else {
            state = .stopped
            process = nil
            return
        }

        state = .stopping
        proc.interrupt()  // SIGINT

        // Wait up to 5s for graceful shutdown
        let stopped = await waitForTermination(process: proc, timeout: 5)
        if !stopped {
            proc.terminate()  // SIGTERM fallback
        }

        self.process = nil
        state = .stopped
    }

    /// Check if the gateway is reachable via HTTP health endpoint.
    public func checkHealth() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return false }
            let health = try JSONDecoder().decode(HealthResponse.self, from: data)
            return health.status == "ok"
        } catch {
            return false
        }
    }

    // MARK: - Private

    private func resolveNodePath() -> String {
        // Check common locations
        let candidates = [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/bin/node",
        ]
        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        // Fallback: rely on PATH
        return "/usr/bin/env"
    }

    private func pollHealth(maxWait: TimeInterval) async -> Bool {
        let start = Date()
        while Date().timeIntervalSince(start) < maxWait {
            if await checkHealth() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }

    private func waitForTermination(process: Process, timeout: TimeInterval) async -> Bool {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if !process.isRunning { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return !process.isRunning
    }
}

enum ProcessManagerError: Error, LocalizedError {
    case launchFailed(String)
    case healthCheckFailed
    case notRunning

    var errorDescription: String? {
        switch self {
        case .launchFailed(let msg): return "Failed to launch gateway: \(msg)"
        case .healthCheckFailed: return "Gateway started but health check failed"
        case .notRunning: return "Gateway is not running"
        }
    }
}
