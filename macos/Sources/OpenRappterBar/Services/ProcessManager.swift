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

    public enum LifecycleResult: Equatable, Sendable {
        case started
        case alreadyRunning
        case stopped
        case alreadyStopped
        case superseded
    }

    public enum LifecycleRequest: Equatable, Sendable {
        case start
        case stop
    }

    private enum LifecycleAction {
        case start
        case stop
    }

    public private(set) var state: ProcessState = .stopped
    private var process: Process?
    private let port: Int
    private let nodePathResolver: () -> String?
    private let gatewayDetector: (@MainActor () async -> Bool)?
    private let processStopper: (@MainActor (Process) async -> Void)?
    private let lifecycleObserver: (@MainActor (LifecycleRequest) -> Void)?
    private var lifecycleGeneration: UInt = 0
    private var lifecycleAction: LifecycleAction?
    private var lifecycleTask: Task<LifecycleResult, Error>?

    public init(
        port: Int = 18790,
        nodePathResolver: (() -> String?)? = nil,
        gatewayDetector: (@MainActor () async -> Bool)? = nil,
        processStopper: (@MainActor (Process) async -> Void)? = nil,
        lifecycleObserver: (@MainActor (LifecycleRequest) -> Void)? = nil
    ) {
        self.port = port
        self.gatewayDetector = gatewayDetector
        self.processStopper = processStopper
        self.lifecycleObserver = lifecycleObserver
        self.nodePathResolver = nodePathResolver ?? {
            ProcessManager.firstExistingNodePath(
                candidates: [
                    "/usr/local/bin/node",
                    "/opt/homebrew/bin/node",
                    "/usr/bin/node",
                ],
                pathEnv: ProcessInfo.processInfo.environment["PATH"]
            )
        }
    }

    /// Resolve the path to the TypeScript project root.
    public var projectPath: String {
        Self.resolveProjectPath()
    }

    public static func resolveProjectPath(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: String = NSHomeDirectory(),
        executableURL: URL? = Bundle.main.executableURL,
        currentDirectory: String = FileManager.default.currentDirectoryPath,
        fileManager: FileManager = .default
    ) -> String {
        var candidates: [String] = []

        if let configured = environment["OPENRAPPTER_PATH"], !configured.isEmpty {
            candidates.append(configured)
        }

        let configPath = homeDirectory + "/.openrappter/config.json"
        if fileManager.fileExists(atPath: configPath),
           let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let configured = json["projectPath"] as? String,
           !configured.isEmpty {
            candidates.append(configured)
        }

        candidates.append(homeDirectory + "/.local/share/openrappter/current")
        candidates.append(homeDirectory + "/.openrappter")
        candidates.append(homeDirectory + "/.npm-global/lib/node_modules/openrappter")
        candidates.append(homeDirectory + "/.local/lib/node_modules/openrappter")
        for binDirectory in nodeSearchPath(
            homeDirectory: homeDirectory,
            parentPath: environment["PATH"],
            fileManager: fileManager
        ).split(separator: ":") {
            candidates.append(
                URL(fileURLWithPath: String(binDirectory))
                    .deletingLastPathComponent()
                    .appendingPathComponent("lib/node_modules/openrappter")
                    .path
            )
        }
        candidates.append("/opt/homebrew/lib/node_modules/openrappter")
        candidates.append("/usr/local/lib/node_modules/openrappter")
        candidates.append(currentDirectory)
        candidates.append((currentDirectory as NSString).deletingLastPathComponent)

        if let executableURL {
            let contents = executableURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            candidates.append(contents.appendingPathComponent("Resources/openrappter").path)
            candidates.append(
                contents
                    .deletingLastPathComponent()
                    .deletingLastPathComponent()
                    .appendingPathComponent("typescript")
                    .path
            )
        }

        for candidate in candidates {
            let expanded = candidate.hasPrefix("~/")
                ? homeDirectory + String(candidate.dropFirst())
                : candidate
            let directPackage = (expanded as NSString).appendingPathComponent("package.json")
            if fileManager.fileExists(atPath: directPackage) {
                return URL(fileURLWithPath: expanded).standardizedFileURL.path
            }

            let typescript = (expanded as NSString).appendingPathComponent("typescript")
            let nestedPackage = (typescript as NSString).appendingPathComponent("package.json")
            if fileManager.fileExists(atPath: nestedPackage) {
                return URL(fileURLWithPath: typescript).standardizedFileURL.path
            }
        }

        return homeDirectory + "/.local/share/openrappter/current/typescript"
    }

    public static func nodeSearchPath(
        homeDirectory: String = NSHomeDirectory(),
        parentPath: String? = ProcessInfo.processInfo.environment["PATH"],
        fileManager: FileManager = .default
    ) -> String {
        var candidates: [String] = []

        func appendVersionedBins(root: String, prefix: String? = nil) {
            guard let entries = try? fileManager.contentsOfDirectory(atPath: root)
            else { return }
            for entry in entries.sorted(by: >) {
                if let prefix, !entry.hasPrefix(prefix) { continue }
                candidates.append(
                    (root as NSString).appendingPathComponent(entry + "/bin")
                )
            }
        }

        appendVersionedBins(
            root: homeDirectory + "/.openrappter/tools",
            prefix: "node-v"
        )
        appendVersionedBins(root: homeDirectory + "/.nvm/versions/node")
        candidates.append(homeDirectory + "/.volta/bin")
        candidates.append(homeDirectory + "/.local/share/fnm/aliases/default/bin")
        candidates.append(
            homeDirectory + "/Library/Application Support/fnm/aliases/default/bin"
        )
        candidates.append(homeDirectory + "/.local/share/mise/shims")
        candidates.append(homeDirectory + "/.asdf/shims")
        candidates.append(homeDirectory + "/.local/bin")
        candidates.append("/opt/homebrew/bin")
        candidates.append("/usr/local/bin")
        candidates.append("/usr/bin")
        candidates.append("/bin")
        if let parentPath {
            candidates.append(contentsOf: parentPath.split(separator: ":").map(String.init))
        }

        var seen = Set<String>()
        return candidates
            .filter { seen.insert($0).inserted }
            .joined(separator: ":")
    }

    public static func resolveNodeExecutable(
        homeDirectory: String = NSHomeDirectory(),
        parentPath: String? = ProcessInfo.processInfo.environment["PATH"],
        fileManager: FileManager = .default
    ) -> String? {
        for directory in nodeSearchPath(
            homeDirectory: homeDirectory,
            parentPath: parentPath,
            fileManager: fileManager
        ).split(separator: ":") {
            let candidate = (String(directory) as NSString)
                .appendingPathComponent("node")
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    /// The launch agent manager for auto-start on login.
    public let launchAgent = LaunchAgentManager()

    /// Check if the gateway port is already in use (another instance may be running).
    public func isPortInUse() async -> Bool {
        await NetworkDiscovery.isPortInUse(port)
    }

    /// Detect and connect to an already-running gateway instance.
    public func detectRunningGateway() async -> Bool {
        if let gatewayDetector {
            return await gatewayDetector()
        }
        // First check if port is in use
        guard await isPortInUse() else { return false }
        // Then verify it's actually a gateway via health check
        return await checkHealth()
    }

    /// Start the gateway process.
    ///
    /// Duplicate calls join the same task and receive the same result. An
    /// opposite lifecycle request supersedes this one, but waits for any
    /// process it spawned to be fully terminated before it can proceed.
    @discardableResult
    public func start() async throws -> LifecycleResult {
        lifecycleObserver?(.start)
        if lifecycleAction == .start, let lifecycleTask {
            return try await lifecycleTask.value
        }

        lifecycleGeneration &+= 1
        let generation = lifecycleGeneration
        let previousTask = lifecycleTask
        let task = Task { @MainActor [weak self] () throws -> LifecycleResult in
            if let previousTask {
                _ = try? await previousTask.value
            }
            guard let self, generation == self.lifecycleGeneration else {
                return .superseded
            }
            return try await self.performStart(generation: generation)
        }
        lifecycleAction = .start
        lifecycleTask = task

        do {
            let result = try await task.value
            clearLifecycleTask(generation: generation)
            return result
        } catch {
            clearLifecycleTask(generation: generation)
            throw error
        }
    }

    private func performStart(generation: UInt) async throws -> LifecycleResult {
        guard generation == lifecycleGeneration else { return .superseded }
        if state == .running {
            return .alreadyRunning
        }
        state = .starting

        // Check if gateway is already running on this port
        if await detectRunningGateway() {
            guard generation == lifecycleGeneration else { return .superseded }
            state = .running
            Log.process.info("Detected already-running gateway on port \(self.port)")
            return .alreadyRunning
        }

        guard generation == lifecycleGeneration else { return .superseded }
        guard let nodePath = resolveNodePath() else {
            if generation == lifecycleGeneration { state = .stopped }
            throw ProcessManagerError.nodeNotFound
        }

        let tsPath = projectPath

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["dist/index.js", "--daemon", "--port", String(port)]
        proc.currentDirectoryURL = URL(fileURLWithPath: tsPath)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            guard generation == lifecycleGeneration else {
                await stopManagedProcess(proc)
                return .superseded
            }
            self.process = proc

            // Poll /health until ready (up to 15s)
            let ready = await pollHealth(maxWait: 15, generation: generation)
            guard generation == lifecycleGeneration else {
                if self.process === proc {
                    self.process = nil
                }
                await stopManagedProcess(proc)
                return .superseded
            }
            if ready {
                state = .running
                return .started
            } else {
                // Process started but health check failed — stop the process we
                // just spawned via its exact PID (never by name).
                await stopManagedProcess(proc)
                self.process = nil
                state = .stopped
                throw ProcessManagerError.healthCheckFailed
            }
        } catch let error as ProcessManagerError {
            if generation == lifecycleGeneration { state = .stopped }
            throw error
        } catch {
            if generation == lifecycleGeneration { state = .stopped }
            throw ProcessManagerError.launchFailed(error.localizedDescription)
        }
    }

    /// Stop the gateway process — but only if this instance actually owns it
    /// (i.e. this app spawned `process`). Externally-detected gateways are
    /// never touched here since `process` stays `nil` for them.
    ///
    /// Duplicate calls join the in-flight stop. If a start is still resolving
    /// detection or cleaning up a newly-spawned child, stop waits for that
    /// work before returning, so shutdown never completes ahead of termination.
    @discardableResult
    public func stop() async -> LifecycleResult {
        lifecycleObserver?(.stop)
        if lifecycleAction == .stop, let lifecycleTask {
            return (try? await lifecycleTask.value) ?? .stopped
        }

        lifecycleGeneration &+= 1
        let generation = lifecycleGeneration
        let previousTask = lifecycleTask
        let task = Task { @MainActor [weak self] () throws -> LifecycleResult in
            if let previousTask {
                _ = try? await previousTask.value
            }
            guard let self, generation == self.lifecycleGeneration else {
                return .superseded
            }
            return await self.performStop(generation: generation)
        }
        lifecycleAction = .stop
        lifecycleTask = task

        let result = (try? await task.value) ?? .stopped
        clearLifecycleTask(generation: generation)
        return result
    }

    private func performStop(generation: UInt) async -> LifecycleResult {
        guard generation == lifecycleGeneration else { return .superseded }
        let wasAlreadyStopped = state == .stopped

        guard let proc = process, proc.isRunning else {
            state = .stopped
            process = nil
            return wasAlreadyStopped ? .alreadyStopped : .stopped
        }

        state = .stopping
        await stopManagedProcess(proc)
        if self.process === proc {
            self.process = nil
        }
        state = .stopped
        return generation == lifecycleGeneration ? .stopped : .superseded
    }

    /// Gracefully terminate `proc`, escalating from SIGINT → SIGTERM → SIGKILL,
    /// each bounded by a timeout. Every signal targets `proc`'s own exact PID
    /// (via `Process`'s `interrupt()`/`terminate()` or `kill(pid, ...)`) —
    /// never a name-based kill that could affect processes this app didn't start.
    func stopProcess(
        _ proc: Process,
        sigintTimeout: TimeInterval = AppConstants.gracefulShutdownTimeout,
        sigtermTimeout: TimeInterval = AppConstants.terminateTimeout,
        sigkillTimeout: TimeInterval = AppConstants.killTimeout
    ) async {
        guard proc.isRunning else { return }
        let pid = proc.processIdentifier

        proc.interrupt()  // SIGINT — cooperative shutdown
        if await waitForTermination(process: proc, timeout: sigintTimeout) { return }

        proc.terminate()  // SIGTERM — still scoped to this exact Process/pid
        if await waitForTermination(process: proc, timeout: sigtermTimeout) { return }

        if proc.isRunning {
            Log.process.warning("Gateway pid \(pid) unresponsive to SIGINT/SIGTERM — escalating to SIGKILL")
            kill(pid, SIGKILL)  // Final bounded escalation, by exact managed PID only.
            _ = await waitForTermination(process: proc, timeout: sigkillTimeout)
        }
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

    /// Resolve an actual `node` executable path. Never falls back to
    /// `/usr/bin/env` — that is a shell-resolution shim, not a node
    /// interpreter, and handing it to `Process.executableURL` with
    /// `dist/index.js` as the first argument would either fail outright or
    /// silently run the wrong binary. Returns `nil` (a clear, actionable
    /// error from the caller) when no node executable can be found.
    func resolveNodePath() -> String? {
        nodePathResolver()
    }

    /// Pure, dependency-injected node lookup: checks `candidates` in order,
    /// then searches `pathEnv` directories for a `node` binary. Never
    /// returns `/usr/bin/env` or any other non-node shim — returns `nil`
    /// when nothing is found so the caller can surface a clear error.
    static func firstExistingNodePath(
        candidates: [String],
        pathEnv: String?,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String? {
        for path in candidates where fileExists(path) {
            return path
        }

        if let pathEnv {
            for dir in pathEnv.split(separator: ":") {
                let candidate = String(dir) + "/node"
                if fileExists(candidate) {
                    return candidate
                }
            }
        }

        return nil
    }

    private func pollHealth(maxWait: TimeInterval, generation: UInt) async -> Bool {
        let start = Date()
        while Date().timeIntervalSince(start) < maxWait {
            guard generation == lifecycleGeneration, !Task.isCancelled else {
                return false
            }
            if await checkHealth() {
                return true
            }
            do {
                try await Task.sleep(for: .milliseconds(500))
            } catch {
                return false
            }
        }
        return false
    }

    private func stopManagedProcess(_ proc: Process) async {
        if let processStopper {
            await processStopper(proc)
        } else {
            await stopProcess(proc)
        }
    }

    private func clearLifecycleTask(generation: UInt) {
        guard generation == lifecycleGeneration else { return }
        lifecycleTask = nil
        lifecycleAction = nil
    }

    private func waitForTermination(process: Process, timeout: TimeInterval) async -> Bool {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if !process.isRunning { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return !process.isRunning
    }

    // MARK: - Test Support
    //
    // Seams for behavior tests to simulate specific ownership states without
    // needing a real Node install / built `dist/index.js`. `internal`, not
    // `public` — reachable only via `@testable import` from the test target.

    /// Simulate detecting an already-running, externally-owned gateway —
    /// `state` becomes `.running` while `process` stays `nil`, exactly as
    /// `start()` leaves it after `detectRunningGateway()` succeeds. Used to
    /// prove `stop()` never touches a process this app didn't spawn.
    func simulateExternallyDetectedGateway() {
        process = nil
        state = .running
    }

    /// Simulate this app having spawned and adopted `proc` as the managed
    /// gateway process, as `start()` does after `proc.run()` succeeds.
    func adoptForTesting(_ proc: Process) {
        process = proc
        state = .running
    }
}

enum ProcessManagerError: Error, LocalizedError {
    case launchFailed(String)
    case healthCheckFailed
    case notRunning
    case nodeNotFound

    var errorDescription: String? {
        switch self {
        case .launchFailed(let msg): return "Failed to launch gateway: \(msg)"
        case .healthCheckFailed: return "Gateway started but health check failed"
        case .notRunning: return "Gateway is not running"
        case .nodeNotFound: return "Could not locate a node executable. Install Node.js or set OPENRAPPTER_PATH."
        }
    }
}
