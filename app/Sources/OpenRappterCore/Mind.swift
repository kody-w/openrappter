import Foundation

/// The mind is a Brainstem kernel reached only through `GET /health` and `POST /chat` (rapp-chat/1.0).
/// The app is a client, never a brain.
public struct MindHealth: Sendable, Equatable {
    public var status: String
    public var version: String
    public var model: String
    public var agentCount: Int
    public var copilot: String = ""
    /// The kernel is up but has no Copilot sign-in. The creature shows this as hungry before it even asks.
    public var isHungry: Bool { status == "unauthenticated" || copilot == "no_access" }
}

public struct MindReply: Sendable, Equatable {
    public var text: String           // main text, senses stripped
    public var senses: [String: String]
    public var sessionId: String?
    public var raw: String            // the untouched `response`
    public var voice: String { senses["voice"] ?? "" }
}

public enum MindError: Error, Equatable {
    case unreachable(String)
    case badStatus(Int)
    case badBody(String)
    /// The kernel is up but cannot think: no Copilot sign-in. The creature shows this as "hungry".
    case hungry(String)
    case noCopilot
    case toolsMissing
    case serviceFailed(Int32)
}

public struct MindClient: Sendable {
    public let baseURL: URL
    public var session: URLSession

    public init(baseURL: URL, timeout: TimeInterval = 45) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = timeout
        self.session = URLSession(configuration: cfg)
    }

    public func health() async throws -> MindHealth {
        let (data, resp) = try await get("/health")
        guard let http = resp as? HTTPURLResponse else { throw MindError.unreachable(baseURL.absoluteString) }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self))
        }
        guard let status = obj["status"] as? String, ["ok", "unauthenticated"].contains(status) else {
            throw MindError.badBody("Mind is not ready")
        }
        return MindHealth(
            status: status,
            version: obj["version"] as? String ?? "",
            model: obj["model"] as? String ?? "",
            agentCount: (obj["agents"] as? [Any])?.count ?? 0,
            copilot: obj["copilot"] as? String ?? ""
        )
    }

    /// Start the kernel's GitHub device-code sign-in. The kernel's /login is POST-only (a browser visit answers 405),
    /// so the app starts it and hands the person the code. Returns (user_code, verification_uri).
    public func startLogin() async throws -> (code: String, url: URL) {
        let obj = try await postJSON("/login")
        if Self.hasNoCopilot(obj) { throw MindError.noCopilot }
        guard let code = obj["user_code"] as? String, !code.isEmpty,
              let u = obj["verification_uri"] as? String, let url = URL(string: u),
              url.scheme?.lowercased() == "https", url.host != nil else {
            throw MindError.badBody(String(describing: obj["error"] ?? obj))
        }
        return (code, url)
    }

    /// Ask the kernel whether the device-code sign-in finished: "pending", "success"/"ok", or "expired"/"error".
    public func loginPoll() async throws -> String {
        try await loginProgress().status
    }

    public func loginProgress() async throws -> LoginProgress {
        let obj = try await postJSON("/login/poll")
        let error = obj["error"] as? String
        let noCopilot = Self.hasNoCopilot(obj)
        guard let status = obj["status"] as? String ?? ((error != nil || noCopilot) ? "error" : nil),
              ["pending", "ok", "success", "expired", "error"].contains(status.lowercased()) else {
            throw MindError.badBody("Missing sign-in result")
        }
        return LoginProgress(status: status, error: noCopilot ? (error ?? "NO_COPILOT_ACCESS") : error)
    }

    private func postJSON(_ path: String) async throws -> [String: Any] {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"; req.httpBody = Data("{}".utf8)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) } catch { throw MindError.unreachable(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw MindError.unreachable(baseURL.absoluteString) }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self))
        }
        return obj
    }

    /// One turn. Sends both `message` (rapp-chat/1.0) and the legacy alias `user_input` so any kernel answers.
    public func chat(_ message: String, sessionId: String? = nil, history: [[String: String]] = []) async throws -> MindReply {
        var body: [String: Any] = [
            "schema": "rapp-chat/1.0",
            "message": message,
            "user_input": message,
            "conversation_history": history,
        ]
        if let sessionId { body["session_id"] = sessionId }
        var req = URLRequest(url: baseURL.appendingPathComponent("chat"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) } catch { throw MindError.unreachable(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw MindError.unreachable(baseURL.absoluteString) }
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let err = (obj["error"] as? String) ?? ""
        if Self.hasNoCopilot(obj) { throw MindError.noCopilot }
        let e = err.lowercased()
        if http.statusCode == 401 || e.contains("sign in") || e.contains("not authenticated") || e.contains("token") {
            throw MindError.hungry(err.isEmpty ? "HTTP \(http.statusCode)" : err)
        }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let response = obj["response"] as? String else {
            throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self))
        }
        let parsed = Senses.parse(response)
        return MindReply(text: parsed.text, senses: parsed.senses,
                         sessionId: obj["session_id"] as? String ?? obj["sessionId"] as? String, raw: response)
    }

    private func get(_ path: String) async throws -> (Data, URLResponse) {
        do { return try await session.data(from: baseURL.appendingPathComponent(path)) }
        catch { throw MindError.unreachable(error.localizedDescription) }
    }

    private static func hasNoCopilot(_ obj: [String: Any]) -> Bool {
        obj["no_copilot_access"] as? Bool == true ||
            (obj["error"] as? String)?.uppercased().hasPrefix("NO_COPILOT_ACCESS") == true
    }
}

/// Attach-or-launch. Candidates in order: `OPENRAPPTER_MIND`, the app's own kernel on :18790, the grail default :7071.
/// Launch = the pinned grail kernel (kernel/kernel.json) in its own home on :18790. It never touches another kernel.
public struct MindRunner {
    private final class ChildMind {
        private let lock = NSLock()
        private var process: Process?

        var isRunning: Bool {
            lock.lock(); defer { lock.unlock() }
            return process?.isRunning == true
        }

        func start(_ make: () throws -> Process) throws -> Process {
            lock.lock(); defer { lock.unlock() }
            if let process, process.isRunning { return process }
            let next = try make()
            process = next
            return next
        }
    }

    private let child = ChildMind()
    public var candidates: [URL]
    public var kernelDir: URL           // folder holding kernel.json + run.sh
    public var kernelHome: URL          // ~/.openrappter/kernel (GODD)
    public var ownPort: Int = 18790
    public var log: @Sendable (String) -> Void = { _ in }
    public var serviceURL: URL?
    public var command: ([String]) -> Int32 = MindRunner.launchctl
    public var toolsReady: () -> Bool = RuntimeTools.available
    public var startupPreference: StartupPreference
    public var automaticStartupDisabled: Bool
    public var makeClient: (URL, TimeInterval) -> MindClient = { MindClient(baseURL: $0, timeout: $1) }

    public init(kernelDir: URL, kernelHome: URL? = nil, env: [String: String] = ProcessInfo.processInfo.environment) {
        self.kernelDir = kernelDir
        self.startupPreference = StartupPreference(home: env["HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser)
        self.automaticStartupDisabled = env["OPENRAPPTER_NO_LOGIN_ITEM"] != nil
        self.kernelHome = kernelHome ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openrappter/kernel")
        var c: [URL] = []
        if let s = env["OPENRAPPTER_MIND"], let u = URL(string: s) { c.append(u) }
        c.append(URL(string: "http://127.0.0.1:18790")!)
        // OPENRAPPTER_OWN_MIND=1: never share a Brainstem someone else installed on :7071; run your own.
        if env["OPENRAPPTER_OWN_MIND"] != "1" { c.append(URL(string: "http://127.0.0.1:7071")!) }
        self.candidates = c
    }

    /// First candidate whose /health answers.
    public func attach() async -> (MindClient, MindHealth)? {
        for url in candidates {
            let client = makeClient(url, 4)
            if let h = try? await client.health() {
                log("attached \(url) v\(h.version) \(h.model) agents=\(h.agentCount)")
                return (makeClient(url, 45), h)
            }
        }
        return nil
    }

    /// Launch the pinned kernel as a child (phase 1). Phase 4 moves this under launchd so it outlives the app.
    @discardableResult
    public func launch() throws -> Process {
        try child.start {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = [kernelDir.appendingPathComponent("run.sh").path]
            var env = ProcessInfo.processInfo.environment
            env["OPENRAPPTER_KERNEL_HOME"] = kernelHome.path
            env["OPENRAPPTER_KERNEL_PORT"] = String(ownPort)
            p.environment = env
            try p.run()
            log("launched kernel pid \(p.processIdentifier) home \(kernelHome.path) port \(ownPort)")
            return p
        }
    }

    /// Attach, or launch and wait up to `wait` seconds for /health.
    public func attachOrLaunch(wait: TimeInterval = 180) async throws -> (MindClient, MindHealth) {
        if let a = await attach() { return a }
        try launch()
        let own = MindClient(baseURL: URL(string: "http://127.0.0.1:\(ownPort)")!, timeout: 3)
        let deadline = Date().addingTimeInterval(wait)
        while Date() < deadline {
            if let h = try? await own.health() {
                log("own kernel healthy v\(h.version)")
                return (MindClient(baseURL: own.baseURL), h)
            }

            try? await Task.sleep(for: .seconds(2))
        }
        throw MindError.unreachable("own kernel did not answer /health within \(Int(wait))s")
    }

    /// An installed or already loaded mind may simply be starting. Never bounce it to discover it.
    public func prepareService(allowStartup: Bool = false) throws {
        guard toolsReady() else { throw MindError.toolsMissing }
        let domain = "gui/\(getuid())"
        let loaded = command(["print", "\(domain)/\(Self.serviceLabel)"]) == 0
        if automaticStartupDisabled || (startupPreference.isStopped && !allowStartup) {
            if loaded { try refreshLauncher() }
            else { _ = try launch() }
            return
        }
        if allowStartup {
            try installService(allowStartup: true)
            return
        }
        if loaded { try refreshLauncher(); return }
        if serviceInstalled {
            try refreshLauncher()
            if child.isRunning { return }
            let status = command(["bootstrap", domain, launchAgentURL.path])
            guard status == 0 else { throw MindError.serviceFailed(status) }
            return
        }
        try installService()
    }

    public func findMind(attempts: Int = 900,
                         sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
                         onWaiting: (() async -> Void)? = nil) async throws -> (MindClient, MindHealth) {
        if let attached = await attach() {
            if serviceInstalled || FileManager.default.fileExists(atPath: kernelHome.appendingPathComponent("launcher").path) {
                do { try refreshLauncher() }
                catch { log("attached mind is ready; launcher refresh failed: \(error)") }
            }
            return attached
        }
        try prepareService()
        let own = makeClient(URL(string: "http://127.0.0.1:\(ownPort)")!, 3)
        for attempt in 0..<attempts {
            try Task.checkCancellation()
            if let health = try? await own.health() { return (makeClient(own.baseURL, 45), health) }
            if attempt >= 30 && attempt.isMultiple(of: 30) { await onWaiting?() }
            try await sleep(2)
        }
        throw MindError.unreachable("Mind did not become ready")
    }
}

// MARK: - The kernel outlives the app (launchd)

extension MindRunner {
    public static let serviceLabel = "com.openrappter.kernel"
    public var launchAgentURL: URL {
        serviceURL ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(Self.serviceLabel).plist")
    }

    /// Copies kernel.json + run.sh into the kernel home (so the service does not depend on where the app lives),
    /// writes the LaunchAgent, and loads it. KeepAlive restarts it; RunAtLoad starts it at login. Never touches :7071.
    public func installService(allowStartup: Bool = false) throws {
        guard toolsReady() else { throw MindError.toolsMissing }
        if automaticStartupDisabled || (startupPreference.isStopped && !allowStartup) {
            _ = try launch()
            return
        }
        let fm = FileManager.default
        let dst = kernelHome.appendingPathComponent("launcher")
        try refreshLauncher()
        let logDir = kernelHome.appendingPathComponent("logs"); try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "Label": Self.serviceLabel,
            "ProgramArguments": ["/bin/sh", dst.appendingPathComponent("run.sh").path],
            "EnvironmentVariables": ["OPENRAPPTER_KERNEL_HOME": kernelHome.path, "OPENRAPPTER_KERNEL_PORT": String(ownPort),
                                     "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
            "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": 60,
            "StandardOutPath": logDir.appendingPathComponent("kernel.log").path,
            "StandardErrorPath": logDir.appendingPathComponent("kernel.err.log").path,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try fm.createDirectory(at: launchAgentURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: launchAgentURL, options: .atomic)
        if allowStartup {
            let status = command(["enable", "gui/\(getuid())/\(Self.serviceLabel)"])
            guard status == 0 else { throw MindError.serviceFailed(status) }
        }
        if command(["print", "gui/\(getuid())/\(Self.serviceLabel)"]) == 0 || child.isRunning { return }
        let r = command(["bootstrap", "gui/\(getuid())", launchAgentURL.path])
        log("service \(Self.serviceLabel) bootstrap exit \(r)")
        guard r == 0 else { throw MindError.serviceFailed(r) }
    }

    /// Atomic replacement refreshes future starts without interrupting an already running mind.
    public func refreshLauncher() throws {
        let files = try ["kernel.json", "run.sh"].map { ($0, try Data(contentsOf: kernelDir.appendingPathComponent($0))) }
        let fm = FileManager.default
        let dst = kernelHome.appendingPathComponent("launcher")
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)
        for (name, data) in files {
            let url = dst.appendingPathComponent(name)
            if fm.fileExists(atPath: url.path) {
                if try Data(contentsOf: url) == data { continue }
            }
            try data.write(to: url, options: .atomic)
        }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.appendingPathComponent("run.sh").path)
    }

    public func stopStartingAtLogin() throws {
        if serviceInstalled { try FileManager.default.removeItem(at: launchAgentURL) }
        let status = command(["disable", "gui/\(getuid())/\(Self.serviceLabel)"])
        guard status == 0 else { throw MindError.serviceFailed(status) }
    }

    public func removeService() {
        _ = command(["bootout", "gui/\(getuid())/\(Self.serviceLabel)"])
        try? FileManager.default.removeItem(at: launchAgentURL)
    }

    public var serviceInstalled: Bool { FileManager.default.fileExists(atPath: launchAgentURL.path) }

    public static func launchctl(_ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl"); p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }
}
