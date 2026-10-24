import Foundation

/// The mind is a Brainstem kernel reached only through `GET /health` and `POST /chat` (rapp-chat/1.0).
/// The app is a client, never a brain.
public struct MindHealth: Sendable, Equatable {
    public var status: String
    public var version: String
    public var model: String
    public var agentCount: Int
    /// `copilot` from /health: "✓", "pending" or "no_access" (grail 0.6.16). Empty when the kernel does not say.
    public var copilot: String = ""
    /// `copilot_username` from /health when the account is signed in but has no Copilot.
    public var copilotUsername: String = ""
    /// `auth_error` from /health ("invalid_credentials" = the stored GitHub sign-in is bad; sign in again).
    public var authError: String = ""
    /// The kernel is up but has no Copilot sign-in. The creature shows this as hungry before it even asks.
    public var isHungry: Bool { status == "unauthenticated" }
    /// Signed in, but the GitHub account has no Copilot. Not hungry (a sign-in will not fix it) and not fed.
    public var needsCopilot: Bool { copilot == "no_access" }
}

extension MindError {
    /// The plain sentence for a signed-in account that has no Copilot. `who` is the GitHub login when the kernel says it.
    public static func noCopilotSentence(_ who: String) -> String {
        let account = who.isEmpty ? "This GitHub account" : "The GitHub account \(who)"
        return "\(account) can't use Copilot yet. Turn it on at github.com/settings/copilot, then ask me again."
    }
}

public struct MindReply: Sendable, Equatable {
    public var text: String           // main text, senses stripped
    public var senses: [String: String]
    public var sessionId: String?
    public var raw: String            // the untouched `response`
    public var voice: String { senses["voice"] ?? "" }
}

/// What the kernel hands back when a GitHub sign-in starts: a short code to paste on GitHub's device page.
public struct SignIn: Sendable, Equatable {
    public var code: String
    public var url: URL
    public init(code: String, url: URL) { self.code = code; self.url = url }

    /// Parses the kernel's `POST /login` (or `GET /login/status`) body. Nil when there is no code in it.
    public static func parse(_ data: Data) -> SignIn? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let code = obj["user_code"] as? String, !code.isEmpty,
              let u = obj["verification_uri"] as? String, let url = URL(string: u), url.scheme == "https" else { return nil }
        return SignIn(code: code, url: url)
    }
}

public enum MindError: Error, Equatable {
    case unreachable(String)
    case badStatus(Int)
    case badBody(String)
    /// The kernel is up but cannot think: no Copilot sign-in. The creature shows this as "hungry".
    case hungry(String)
    /// Signed in, but the GitHub account has no Copilot. Carries the plain sentence to show and say. Never "fed".
    case noCopilot(String)
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
            agentCount: (obj["agents"] as? [Any])?.count ?? 0,
            copilot: obj["copilot"] as? String ?? "",
            copilotUsername: obj["copilot_username"] as? String ?? "",
            authError: obj["auth_error"] as? String ?? ""
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
        // Signed in, no Copilot: grail 0.6.16 answers HTTP 200 {"error":"NO_COPILOT_ACCESS:<user>","no_copilot_access":true}.
        if obj["no_copilot_access"] as? Bool == true || e.hasPrefix("no_copilot_access:") {
            let who = (obj["copilot_username"] as? String) ?? String(err.drop(while: { $0 != ":" }).dropFirst())
            throw MindError.noCopilot(MindError.noCopilotSentence(who == "this account" ? "" : who))
        }
        if http.statusCode == 401 || e.contains("sign in") || e.contains("not authenticated") || e.contains("token") {
            throw MindError.hungry(err.isEmpty ? "HTTP \(http.statusCode)" : err)
        }
        // A 5xx with the kernel's own plain sentence (usage limit, model timeout): keep the sentence, the creature says it.
        if http.statusCode >= 500, !err.isEmpty { throw MindError.badBody(err) }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let response = obj["response"] as? String else {
            throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self))
        }
        let parsed = Senses.parse(response)
        return MindReply(text: parsed.text, senses: parsed.senses,
                         sessionId: obj["session_id"] as? String ?? obj["sessionId"] as? String, raw: response)
    }

    /// Starts (or resumes) the kernel's GitHub device sign-in. The kernel keeps polling GitHub by itself;
    /// the app only has to show the code, open the page, and watch `/health` turn from hungry to fed.
    public func beginSignIn() async throws -> SignIn {
        var req = URLRequest(url: baseURL.appendingPathComponent("login"))
        req.httpMethod = "POST"
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) } catch { throw MindError.unreachable(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw MindError.unreachable(baseURL.absoluteString) }
        guard http.statusCode == 200 else { throw MindError.badStatus(http.statusCode) }
        guard let s = SignIn.parse(data) else { throw MindError.badBody(String(decoding: data.prefix(200), as: UTF8.self)) }
        return s
    }

    private func get(_ path: String) async throws -> (Data, URLResponse) {
        do { return try await session.data(from: baseURL.appendingPathComponent(path)) }
        catch { throw MindError.unreachable(error.localizedDescription) }
    }
}

/// The kernel pin (kernel/kernel.json): which grail commit the app runs. Read-only; the pin is moved on purpose.
public struct KernelPin: Sendable, Equatable {
    public var sha: String
    public var version: String

    public init?(contentsOf url: URL) {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sha = obj["sha"] as? String, !sha.isEmpty else { return nil }
        self.sha = sha
        self.version = obj["version"] as? String ?? ""
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

    /// First candidate whose /health answers. The app's own kernel on `ownPort` is skipped when it is behind the
    /// pin (see `ownKernelIsStale`): the caller then relaunches the pinned one instead of attaching to the old one.
    /// A stale own kernel stops the search (never falls through to a stranger's :7071 while ours needs relaunching).
    public func attach() async -> (MindClient, MindHealth)? {
        for url in candidates {
            let client = MindClient(baseURL: url, timeout: 4)
            if let h = try? await client.health() {
                if isOwn(url), ownKernelIsStale(h) {
                    log("own kernel \(url) v\(h.version) is behind the pin v\(pinnedKernel?.version ?? "?"); relaunching")
                    return nil
                }
                log("attached \(url) v\(h.version) \(h.model) agents=\(h.agentCount)")
                return (MindClient(baseURL: url), h)
            }
        }
        return nil
    }

    /// The pin the app ships (kernel/kernel.json). nil when it cannot be read (then nothing is compared).
    public var pinnedKernel: KernelPin? { KernelPin(contentsOf: kernelDir.appendingPathComponent("kernel.json")) }
    /// The pin the login service runs from (copied there by `installService`). nil when the kernel was started another way.
    public var installedKernel: KernelPin? { KernelPin(contentsOf: kernelHome.appendingPathComponent("launcher/kernel.json")) }

    func isOwn(_ url: URL) -> Bool {
        url.port == ownPort && ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
    }

    /// How a stale own kernel is detected. /health gives only `version` (no sha), so:
    /// 1. `health.version` != the pinned version → stale (the VERSION file in the kernel repo moves with releases);
    /// 2. same version, but the service's copied kernel.json carries another sha than the pin → stale (a pin moved
    ///    within a version). When the service copy is missing, only (1) applies. No pin readable → never stale.
    public func ownKernelIsStale(_ h: MindHealth) -> Bool {
        guard let pin = pinnedKernel else { return false }
        if !h.version.isEmpty, h.version != pin.version { return true }
        if let installed = installedKernel, installed.sha != pin.sha { return true }
        return false
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

    /// The LaunchAgent as written. `Label` equals the plist file name, so `launchctl bootout gui/$UID/<label>` and
    /// deleting `launchAgentURL` take the service out again cleanly. Pure: nothing is written here.
    public func servicePlist() -> [String: Any] {
        let dst = kernelHome.appendingPathComponent("launcher")
        let logDir = kernelHome.appendingPathComponent("logs")
        return [
            "Label": Self.serviceLabel,
            "ProgramArguments": ["/bin/sh", dst.appendingPathComponent("run.sh").path],
            "EnvironmentVariables": ["OPENRAPPTER_KERNEL_HOME": kernelHome.path, "OPENRAPPTER_KERNEL_PORT": String(ownPort),
                                     "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
            "RunAtLoad": true, "KeepAlive": true,
            "StandardOutPath": logDir.appendingPathComponent("kernel.log").path,
            "StandardErrorPath": logDir.appendingPathComponent("kernel.err.log").path,
        ]
    }

    /// Copies kernel.json + run.sh into the kernel home (so the service does not depend on where the app lives),
    /// writes the LaunchAgent, and loads it. KeepAlive restarts it; RunAtLoad starts it at login. Never touches :7071.
    /// Explicit only: the app calls this on first run with no kernel and from the login menu item; nothing in
    /// MindRunner calls it on its own (a stale own kernel makes `attach()` return nil and leaves the choice to the app).
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
        let data = try PropertyListSerialization.data(fromPropertyList: servicePlist(), format: .xml, options: 0)
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

// MARK: - Opt-in service, and the tools the kernel needs before it can start

extension MindRunner {
    /// Stops the login service and removes it. Throws when the plist is there but cannot be removed.
    public func uninstallService() throws {
        _ = Self.launchctl(["bootout", "gui/\(getuid())/\(Self.serviceLabel)"])
        if FileManager.default.fileExists(atPath: launchAgentURL.path) {
            try FileManager.default.removeItem(at: launchAgentURL)
        }
        log("service \(Self.serviceLabel) removed")
    }

    /// What run.sh needs: git and python3. On a Mac without Apple's command line tools, /usr/bin holds stubs
    /// that pop the "install the tools?" dialog instead of running, so those count as missing too.
    public static let kernelTools = ["git", "python3"]
    public static let kernelPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

    public static func missingTools() -> [String] {
        let clt = run("/usr/bin/xcode-select", ["-p"]).status == 0
        var resolved: [String: String?] = [:]
        for t in kernelTools {
            let r = run("/bin/sh", ["-c", "command -v \(t)"], path: kernelPath)
            let p = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            resolved[t] = (r.status == 0 && !p.isEmpty) ? p : nil
        }
        return missingTools(commandLineToolsInstalled: clt, resolved: resolved)
    }

    /// The pure half: a tool is missing when it is not on the path, or when it is Apple's /usr/bin stub
    /// and the command line tools are not installed.
    public static func missingTools(commandLineToolsInstalled: Bool, resolved: [String: String?]) -> [String] {
        kernelTools.filter { t in
            guard let p = resolved[t] ?? nil else { return true }
            return !commandLineToolsInstalled && p.hasPrefix("/usr/bin/")
        }
    }

    /// Pops Apple's "install the command line tools" dialog. Returns once the dialog is up, not when it finishes.
    public static func installCommandLineTools() {
        _ = run("/usr/bin/xcode-select", ["--install"])
    }

    static func run(_ exe: String, _ args: [String], path: String? = nil) -> (status: Int32, output: String) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
        if let path { var env = ProcessInfo.processInfo.environment; env["PATH"] = path; p.environment = env }
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, "") }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
