import Foundation
import Darwin

/// doors/1 — the one way any script, agent or job on this Mac reaches what macOS guards (Reminders, Notes, Messages).
/// The app holds the macOS approvals once; callers speak JSON lines over a 0600 Unix socket. Contract: contracts/doors.md.
/// A door is an action behind the existing "needs" approval: the first call from a new caller asks Kody in the notch.
public enum DoorsSpec {
    public static let version = "doors/1"
    /// Doors that never touch private data and never ask: discovery only.
    public static let open: Set<String> = ["doors.hello", "doors.log"]
}

public struct DoorError: Error, Equatable { public let message: String; public init(_ m: String) { message = m } }

public enum DoorDecision: String, Codable, Sendable { case once, always, no }

/// "Always" answers, kept in ~/.openrappter/doors-allow.json as {"allow": {"<caller>": ["door", ...]}}.
public final class DoorAllowList: @unchecked Sendable {
    public let url: URL
    private let lock = NSLock()
    public init(url: URL) { self.url = url }

    struct File: Codable { var version: String = DoorsSpec.version; var allow: [String: [String]] = [:] }

    private func read() -> File {
        guard let d = try? Data(contentsOf: url), let f = try? JSONDecoder().decode(File.self, from: d) else { return File() }
        return f
    }

    public func allows(_ caller: String, _ door: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let list = read().allow[caller] ?? []
        return list.contains(door) || list.contains("*")
    }

    public func remember(_ caller: String, _ door: String) {
        lock.lock(); defer { lock.unlock() }
        var f = read()
        var list = f.allow[caller] ?? []
        if !list.contains(door) { list.append(door) }
        f.allow[caller] = list.sorted()
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? enc.encode(f) {
            try? d.write(to: url, options: .atomic)
            chmod(url.path, 0o600)
        }
    }
}

/// Who is knocking: the name the caller gives, else the program behind the socket (from the kernel, not the caller).
public struct DoorCaller: Sendable, Equatable {
    public var name: String
    public var pid: Int32
    public var program: String
    /// One line from the caller saying why it wants this door; shown on the notch card. Optional.
    public var why: String = ""
    public init(name: String, pid: Int32, program: String, why: String = "") { self.name = name; self.pid = pid; self.program = program; self.why = why }
}

/// The socket server. Handlers do the work; `approve` asks the human (blocking, off the main thread).
public final class DoorServer: @unchecked Sendable {
    public typealias Handler = @Sendable ([String: Any]) throws -> Any
    public let socketPath: String
    public let allow: DoorAllowList
    public var handlers: [String: Handler] = [:]
    /// Called for a new (caller, door) pair. Blocks until answered; return .no on timeout.
    public var approve: @Sendable (DoorCaller, String) -> DoorDecision = { _, _ in .no }
    public var log: @Sendable (String) -> Void = { _ in }
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "doors.accept")

    public init(socketPath: String, allow: DoorAllowList) {
        self.socketPath = socketPath; self.allow = allow
        handlers["doors.hello"] = { [weak self] _ in
            ["contract": DoorsSpec.version, "doors": (self?.handlers.keys.sorted() ?? [])] as [String: Any]
        }
    }

    public static var defaultSocket: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/doors.sock").path
    }

    public func start() throws {
        let dir = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        // A caller that hangs up before its reply (a timeout while the notch card waits) must not take the app
        // down: writing to a closed socket raises SIGPIPE, which ends the process silently, with no crash report.
        signal(SIGPIPE, SIG_IGN)
        unlink(socketPath)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DoorError("socket() failed") }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw DoorError("socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { p in for (i, b) in bytes.enumerated() { p[i] = b }; p[bytes.count] = 0 }
        let old = umask(0o177)   // the socket is born 0600: only this user can reach it
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        umask(old)
        guard rc == 0 else { throw DoorError("bind failed: \(String(cString: strerror(errno)))") }
        chmod(socketPath, 0o600)
        guard listen(fd, 16) == 0 else { throw DoorError("listen failed") }
        log("doors listening on \(socketPath)")
        let lfd = fd
        queue.async { [weak self] in
            while true {
                let c = accept(lfd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                var one: Int32 = 1
                setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                DispatchQueue.global().async { self?.serve(c) }
            }
        }
    }

    public func stop() { if fd >= 0 { close(fd); fd = -1 }; unlink(socketPath) }

    static func peer(_ c: Int32) -> (pid: Int32, program: String) {
        var pid: pid_t = 0; var len = socklen_t(MemoryLayout<pid_t>.size)
        getsockopt(c, SOL_LOCAL, LOCAL_PEERPID, &pid, &len)
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return (pid, n > 0 ? String(cString: buf) : "unknown")
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        let (pid, program) = Self.peer(c)
        var pending = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(c, &chunk, chunk.count)
            if n <= 0 { return }
            pending.append(contentsOf: chunk[0..<n])
            while let nl = pending.firstIndex(of: 0x0A) {
                let line = pending.subdata(in: pending.startIndex..<nl)
                pending.removeSubrange(pending.startIndex...nl)
                if line.isEmpty { continue }
                var out = handle(line: line, pid: pid, program: program)
                out.append(0x0A)
                _ = out.withUnsafeBytes { write(c, $0.baseAddress, out.count) }
            }
        }
    }

    /// One request line in, one reply line out. Public so tests can drive it without a socket.
    public static var callTimeout: TimeInterval = 30

    public func handle(line: Data, pid: Int32 = 0, program: String = "test") -> Data {
        func reply(_ obj: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data(#"{"ok":false,"error":"could not encode the result"}"#.utf8)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let door = obj["door"] as? String else {
            return reply(["ok": false, "error": "send one JSON object per line with a \"door\" name"])
        }
        let args = obj["args"] as? [String: Any] ?? [:]
        let name = (obj["caller"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(80)) } ?? (program as NSString).lastPathComponent
        let why = (obj["why"] as? String).map { String($0.prefix(200)) } ?? ""
        let caller = DoorCaller(name: name, pid: pid, program: program, why: why)
        guard let h = handlers[door] else { return reply(["ok": false, "error": "there is no door called \(door)", "contract": DoorsSpec.version]) }
        if !DoorsSpec.open.contains(door) && !allow.allows(name, door) {
            switch approve(caller, door) {
            case .always: allow.remember(name, door); log("door \(door) allowed always for \(name)")
            case .once: log("door \(door) allowed once for \(name)")
            case .no: log("door \(door) refused for \(name)"); return reply(["ok": false, "error": "Kody said no (or did not answer) to \(name) using \(door)"])
            }
        }
        do {
            // Each call gets its own worker and a time limit: one stuck call never holds up the others.
            var res: Result<Any, Error> = .failure(DoorError("no answer"))
            let sem = DispatchSemaphore(value: 0)
            DispatchQueue.global().async { res = Result { try h(args) }; sem.signal() }
            if sem.wait(timeout: .now() + DoorServer.callTimeout) == .timedOut {
                log("door \(door) by \(name) timed out")
                return reply(["ok": false, "error": "\(door) is taking too long (over \(Int(DoorServer.callTimeout)) seconds); try again in a minute"])
            }
            let r = try res.get()
            log("door \(door) by \(name) ok" + (why.isEmpty ? "" : " why=\(why)"))
            if door != "doors.hello" && door != "doors.log" { DecisionLog.add(["caller": name, "door": door, "by": "use", "why": why]) }
            return reply(["ok": true, "result": r])
        } catch let e as DoorError {
            log("door \(door) by \(name) error \(e.message)")
            return reply(["ok": false, "error": e.message])
        } catch {
            return reply(["ok": false, "error": "\(error)"])
        }
    }
}

/// The one record of every door decision (Kody's, the twin's, the safe default): ~/.openrappter/decisions.jsonl.
public enum DecisionLog {
    public static var url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/decisions.jsonl")
    public static func add(_ row: [String: Any]) {
        var r = row; r["ts"] = Date().timeIntervalSince1970
        guard var d = try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]) else { return }
        d.append(0x0A)
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(d); try? h.close() }
        else { try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true); try? d.write(to: url) }
    }
    public static func recent(_ n: Int) -> [[String: Any]] {
        guard let t = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return t.split(separator: "\n").suffix(n).compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
}

/// Kody's twin answers when Kody does not (object, don't confirm). Returns (pick, confidence) or nil.
public typealias TwinAsk = @Sendable (_ question: String, _ options: [String]) -> (String, Double)?
public func twinViaHelper(path: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("bin/rappter-twin").path) -> TwinAsk {
    return { q, opts in
        let p = Process(); p.executableURL = URL(fileURLWithPath: path)
        let i = Pipe(), o = Pipe(); p.standardInput = i; p.standardOutput = o; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        i.fileHandleForWriting.write((try? JSONSerialization.data(withJSONObject: ["question": q, "options": opts])) ?? Data())
        try? i.fileHandleForWriting.close()
        let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
        guard let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let pick = j["pick"] as? String,
              let c = (j["confidence"] as? NSNumber)?.doubleValue else { return nil }
        return (pick, c)
    }
}

/// Asks through the needs folder (the notch card), waiting for the answer file. Runs off the main thread.
public func doorApprovalViaNeeds(needsDir: URL, timeout: TimeInterval = 120, twin: TwinAsk? = twinViaHelper(), sureEnough: Double = 0.8) -> @Sendable (DoorCaller, String) -> DoorDecision {
    return { caller, door in
        let id = "door-\(UUID().uuidString.prefix(8))"
        let need = Need(id: id, title: "\(caller.name) wants to \(door)", ctx: (caller.why.isEmpty ? "" : "Why: \(caller.why)\n") + "Program: \(caller.program) (pid \(caller.pid))",
                        opts: [NeedOption(label: "Allow once", action: "door:once"), NeedOption(label: "Always", rec: true, action: "door:always"),
                               NeedOption(label: "No", action: "door:no")],
                        source: "doors", created: Date().timeIntervalSince1970)
        let url = needsDir.appendingPathComponent("\(id).json")
        try? FileManager.default.createDirectory(at: needsDir, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(need) { try? d.write(to: url, options: .atomic) }
        let ans = needsDir.appendingPathComponent("\(id).answer.json")
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if let d = try? Data(contentsOf: ans), let a = try? JSONDecoder().decode(NeedAnswer.self, from: d) {
                try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(at: ans)
                let dec: DoorDecision = a.action == "door:always" ? .always : a.action == "door:once" ? .once : .no
                DecisionLog.add(["caller": caller.name, "door": door, "by": "Kody", "decision": "\(dec)"])
                return dec
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        try? FileManager.default.removeItem(at: url)   // unanswered: take the card down
        // Kody did not answer: his twin decides if it is sure enough. The twin can allow once, never "always".
        let q = "\(caller.name) wants to use \(door) on Kody's Mac." + (caller.why.isEmpty ? "" : " Why: \(caller.why).") + " Program: \(caller.program)."
        if let twin, let (pick, c) = twin(q, ["Allow once", "No"]), c >= sureEnough {
            let dec: DoorDecision = pick == "Allow once" ? .once : .no
            DecisionLog.add(["caller": caller.name, "door": door, "by": "twin", "decision": "\(dec)", "confidence": c])
            let fyi = Need(id: "twin-\(UUID().uuidString.prefix(8))",
                           title: "Your twin \(dec == .once ? "let" : "stopped") \(caller.name) use \(door) (\(Int(c * 100))% sure)",
                           opts: [NeedOption(label: "OK")], source: "twin", created: Date().timeIntervalSince1970)
            if let d = try? JSONEncoder().encode(fyi) { try? d.write(to: needsDir.appendingPathComponent("\(fyi.id).json"), options: .atomic) }
            return dec
        }
        DecisionLog.add(["caller": caller.name, "door": door, "by": "default", "decision": "no"])
        return .no
    }
}
