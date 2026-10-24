import Foundation

/// The mind is a Brainstem kernel reached only through `GET /health` and `POST /chat` (rapp-chat/1.0).
/// The app is a client, never a brain.
public struct MindHealth: Sendable, Equatable {
    public var status: String
    public var version: String
    public var model: String
    public var agentCount: Int
    /// The kernel is up but has no Copilot sign-in. The creature shows this as hungry before it even asks.
    public var isHungry: Bool { status == "unauthenticated" }
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
}

public struct MindClient: Sendable {
    public let baseURL: URL
    public var session: URLSession

    public init(baseURL: URL, timeout: TimeInterval = 120) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        self.session = URLSession(configuration: cfg)
    }

    public func health() async throws -> MindHealth {
        let (data, resp) = try await get("/health")
        guard let http = resp as? HTTPURLResponse else { throw MindError.unreachable(baseURL.absoluteString) }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self))
        }
        return MindHealth(
            status: obj["status"] as? String ?? "",
            version: obj["version"] as? String ?? "",
            model: obj["model"] as? String ?? "",
            agentCount: (obj["agents"] as? [Any])?.count ?? 0
        )
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
}

/// Attach-or-launch. Candidates in order: `OPENRAPPTER_MIND`, the app's own kernel on :18790, the grail default :7071.
/// Launch = the pinned grail kernel (kernel/kernel.json) in its own home on :18790. It never touches another kernel.
public struct MindRunner {
    public var candidates: [URL]
    public var kernelDir: URL           // folder holding kernel.json + run.sh
    public var kernelHome: URL          // ~/.openrappter/kernel (GODD)
    public var ownPort: Int = 18790
    public var log: @Sendable (String) -> Void = { _ in }

    public init(kernelDir: URL, kernelHome: URL? = nil, env: [String: String] = ProcessInfo.processInfo.environment) {
        self.kernelDir = kernelDir
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
            let client = MindClient(baseURL: url, timeout: 4)
            if let h = try? await client.health() {
                log("attached \(url) v\(h.version) \(h.model) agents=\(h.agentCount)")
                return (MindClient(baseURL: url), h)
            }
        }
        return nil
    }

    /// Launch the pinned kernel as a child (phase 1). Phase 4 moves this under launchd so it outlives the app.
    @discardableResult
    public func launch() throws -> Process {
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
}

// MARK: - The kernel outlives the app (launchd)

extension MindRunner {
    public static let serviceLabel = "com.openrappter.kernel"
    public var launchAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(Self.serviceLabel).plist")
    }

    /// Copies kernel.json + run.sh into the kernel home (so the service does not depend on where the app lives),
    /// writes the LaunchAgent, and loads it. KeepAlive restarts it; RunAtLoad starts it at login. Never touches :7071.
    public func installService() throws {
        let fm = FileManager.default
        let dst = kernelHome.appendingPathComponent("launcher")
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)
        for f in ["kernel.json", "run.sh"] {
            let to = dst.appendingPathComponent(f)
            if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
            try fm.copyItem(at: kernelDir.appendingPathComponent(f), to: to)
        }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.appendingPathComponent("run.sh").path)
        let logDir = kernelHome.appendingPathComponent("logs"); try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "Label": Self.serviceLabel,
            "ProgramArguments": ["/bin/sh", dst.appendingPathComponent("run.sh").path],
            "EnvironmentVariables": ["OPENRAPPTER_KERNEL_HOME": kernelHome.path, "OPENRAPPTER_KERNEL_PORT": String(ownPort),
                                     "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
            "RunAtLoad": true, "KeepAlive": true,
            "StandardOutPath": logDir.appendingPathComponent("kernel.log").path,
            "StandardErrorPath": logDir.appendingPathComponent("kernel.err.log").path,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try fm.createDirectory(at: launchAgentURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: launchAgentURL, options: .atomic)
        _ = Self.launchctl(["bootout", "gui/\(getuid())/\(Self.serviceLabel)"])   // reload if present; harmless otherwise
        let r = Self.launchctl(["bootstrap", "gui/\(getuid())", launchAgentURL.path])
        log("service \(Self.serviceLabel) bootstrap exit \(r)")
    }

    public func removeService() {
        _ = Self.launchctl(["bootout", "gui/\(getuid())/\(Self.serviceLabel)"])
        try? FileManager.default.removeItem(at: launchAgentURL)
    }

    public var serviceInstalled: Bool { FileManager.default.fileExists(atPath: launchAgentURL.path) }

    static func launchctl(_ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl"); p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
    }
}
