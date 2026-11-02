import XCTest
import Darwin
@testable import OpenRappterCore

final class DoorsTests: XCTestCase {
    override func setUp() { DecisionLog.url = URL(fileURLWithPath: "/tmp/dt-log-\(UUID().uuidString.prefix(6)).jsonl") }
    func tmp() -> URL {
        let u = URL(fileURLWithPath: "/tmp/dt-\(UUID().uuidString.prefix(6))")
        try! FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); return u
    }
    func call(_ s: DoorServer, _ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: s.handle(line: Data(json.utf8), program: "/usr/bin/python3")) as! [String: Any]
    }

    func testHelloIsOpenAndUnknownDoorErrors() {
        let d = tmp(); let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        s.handlers["x.y"] = { _ in 1 }
        let r = call(s, #"{"door":"doors.hello"}"#)
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual((r["result"] as? [String: Any])?["contract"] as? String, "doors/1")
        XCTAssertEqual(call(s, #"{"door":"nope"}"#)["ok"] as? Bool, false)
        XCTAssertEqual(call(s, "not json")["ok"] as? Bool, false)
    }

    func testApprovalOnceAlwaysNo() {
        let d = tmp(); let allow = DoorAllowList(url: d.appendingPathComponent("a.json"))
        let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: allow)
        s.handlers["notes.read"] = { a in a["title"] ?? "" }
        final class Box: @unchecked Sendable { var answers: [DoorDecision] = [.no, .once, .always]; var asked: [String] = [] }
        let box = Box()
        let lock = NSLock()
        s.approve = { c, door in lock.lock(); defer { lock.unlock() }; box.asked.append("\(c.name):\(door)"); return box.answers.removeFirst() }
        let req = #"{"door":"notes.read","caller":"beam","args":{"title":"T"}}"#
        XCTAssertEqual(call(s, req)["ok"] as? Bool, false)
        XCTAssertEqual(call(s, req)["result"] as? String, "T")
        XCTAssertEqual(call(s, req)["ok"] as? Bool, true)
        XCTAssertEqual(call(s, req)["ok"] as? Bool, true, "always is remembered: no fourth question")
        XCTAssertEqual(box.asked.count, 3)
        XCTAssertTrue(DoorAllowList(url: allow.url).allows("beam", "notes.read"))
        XCTAssertFalse(allow.allows("beam", "messages.send"))
        // No caller name: the program behind the socket is the caller.
        XCTAssertFalse(allow.allows("python3", "notes.read"))
    }

    func testHandlerErrorIsPlainWords() {
        let d = tmp(); let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        s.approve = { _, _ in .once }
        MacDoors.install(on: s)
        let r = call(s, #"{"door":"notes.publish","args":{}}"#)
        XCTAssertEqual(r["error"] as? String, "missing \"topic\"")
    }

    func testSocketIs0600AndRoundTrips() throws {
        let d = tmp(); let path = d.appendingPathComponent("doors.sock").path
        let s = DoorServer(socketPath: path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        try s.start(); defer { s.stop() }
        var st = stat(); XCTAssertEqual(stat(path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        let c = socket(AF_UNIX, SOCK_STREAM, 0); defer { close(c) }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { p in for (i, b) in Array(path.utf8).enumerated() { p[i] = b } }
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(c, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(rc, 0)
        let req = Array("{\"door\":\"doors.hello\"}\n".utf8); _ = write(c, req, req.count)
        var buf = [UInt8](repeating: 0, count: 4096); var got = Data()
        while !got.contains(0x0A) { let n = read(c, &buf, buf.count); if n <= 0 { break }; got.append(contentsOf: buf[0..<n]) }
        XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("\"ok\":true"), String(decoding: got, as: UTF8.self))
    }

    func testApprovalViaNeedsFolder() {
        let d = tmp(); let ask = doorApprovalViaNeeds(needsDir: d, timeout: 5)
        DispatchQueue.global().async {
            for _ in 0..<40 {
                if let f = try? FileManager.default.contentsOfDirectory(atPath: d.path).first(where: { $0.hasSuffix(".json") }) {
                    let id = f.replacingOccurrences(of: ".json", with: "")
                    try? "{\"id\":\"\(id)\",\"label\":\"Always\",\"action\":\"door:always\",\"answered\":1}".write(toFile: d.appendingPathComponent("\(id).answer.json").path, atomically: true, encoding: .utf8)
                    return
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        XCTAssertEqual(ask(DoorCaller(name: "beam", pid: 1, program: "/x"), "reminders.open"), .always)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: d.path).count, 0, "card and answer cleaned up")
    }

    func testRecentMessagesFromFakeDb() throws {
        let d = tmp(); let db = d.appendingPathComponent("chat.db").path
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        p.arguments = [db, "create table handle(ROWID integer primary key, id text); create table message(ROWID integer primary key, date integer, text text, is_from_me int, handle_id int); insert into handle values(1,'+15550000000'); insert into message values(5,0,'hi',1,1); insert into message values(6,0,'yo',0,1);"]
        try p.run(); p.waitUntilExit()
        let rows = try MacDoors.recentMessages(since: 5, limit: 10, db: db)
        XCTAssertEqual(rows.count, 1); XCTAssertEqual(rows[0]["text"] as? String, "yo")
        let last = try MacDoors.recentMessages(since: 0, limit: 1, newest: true, db: db)
        XCTAssertEqual(last.map { $0["text"] as? String }, ["yo"], "newest:true gives the latest rows, oldest first")
        XCTAssertThrowsError(try MacDoors.recentMessages(since: 0, limit: 1, db: d.appendingPathComponent("none.db").path))
    }

    func dial(_ path: String) -> Int32 {
        let c = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { p in for (i, b) in Array(path.utf8).enumerated() { p[i] = b } }
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(c, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        return c
    }

    /// The 2026-11-02 quits: a caller hanging up before its reply raised SIGPIPE and ended the app silently.
    /// If this regresses, the test process itself dies here.
    func testCallerHangingUpDoesNotKillTheServer() throws {
        let d = tmp(); let path = d.appendingPathComponent("doors.sock").path
        let s = DoorServer(socketPath: path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        s.handlers["slow.door"] = { _ in Thread.sleep(forTimeInterval: 0.2); return String(repeating: "x", count: 200_000) }
        s.approve = { _, _ in .once }
        try s.start(); defer { s.stop() }
        for _ in 0..<5 {
            let c = dial(path); let req = Array("{\"door\":\"slow.door\"}\n".utf8); _ = write(c, req, req.count); close(c)
        }
        Thread.sleep(forTimeInterval: 0.6)
        let c = dial(path); defer { close(c) }
        let req = Array("{\"door\":\"doors.hello\"}\n".utf8); _ = write(c, req, req.count)
        var buf = [UInt8](repeating: 0, count: 4096); var got = Data()
        while !got.contains(0x0A) { let n = read(c, &buf, buf.count); if n <= 0 { break }; got.append(contentsOf: buf[0..<n]) }
        XCTAssertTrue(String(decoding: got, as: UTF8.self).contains("\"ok\":true"))
    }

    func testWhyReachesTheApprovalCard() {
        let d = tmp(); let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        s.handlers["notes.read"] = { _ in "ok" }
        final class Box: @unchecked Sendable { var why = "" }
        let box = Box()
        s.approve = { c, _ in box.why = c.why; return .once }
        _ = call(s, #"{"door":"notes.read","caller":"notes_agent","why":"Read the note you asked about"}"#)
        XCTAssertEqual(box.why, "Read the note you asked about")
        let card = doorApprovalViaNeeds(needsDir: d.appendingPathComponent("n"), timeout: 0.3)
        _ = card(DoorCaller(name: "a", pid: 1, program: "/x", why: "W"), "notes.read")   // times out; card written then removed
    }

    func testRemindersAddNeedsATitle() {
        let d = tmp(); let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        s.approve = { _, _ in .once }
        MacDoors.install(on: s)
        XCTAssertEqual(call(s, #"{"door":"reminders.add","args":{}}"#)["error"] as? String, "missing \"title\"")
    }

    /// Speed guard: a stuck door times out in plain words, and 20 calls at once all answer fast beside it.
    func testStuckDoorTimesOutAndOthersStayFast() {
        let d = tmp(); let s = DoorServer(socketPath: d.appendingPathComponent("s").path, allow: DoorAllowList(url: d.appendingPathComponent("a.json")))
        DoorServer.callTimeout = 1
        defer { DoorServer.callTimeout = 30 }
        s.handlers["doors.hello"] = { _ in Thread.sleep(forTimeInterval: 5); return "late" }
        let t0 = Date()
        let r = call(s, #"{"door":"doors.hello"}"#)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 2)
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertTrue((r["error"] as? String ?? "").contains("taking too long"))
        s.handlers["doors.hello"] = { _ in "hi" }
        let g = DispatchGroup(); let t1 = Date(); var oks = 0; let lock = NSLock()
        for _ in 0..<20 { g.enter(); DispatchQueue.global().async { let x = self.call(s, #"{"door":"doors.hello"}"#); lock.lock(); if x["ok"] as? Bool == true { oks += 1 }; lock.unlock(); g.leave() } }
        g.wait()
        XCTAssertEqual(oks, 20)
        XCTAssertLessThan(Date().timeIntervalSince(t1), 1)
    }


    /// Object, don't confirm: unanswered → the twin decides when ≥80% sure (once, never always), else safe "no"; all logged.
    func testTwinDecidesWhenKodyIsQuiet() {
        let d = tmp(); DecisionLog.url = d.appendingPathComponent("decisions.jsonl")
        let caller = DoorCaller(name: "beam", pid: 1, program: "/bin/x", why: "read errands")
        let sure = doorApprovalViaNeeds(needsDir: d, timeout: 0.3, twin: { _, opts in XCTAssertFalse(opts.contains("Always")); return ("Allow once", 0.86) })
        XCTAssertEqual("\(sure(caller, "reminders.open"))", "\(DoorDecision.once)")
        let unsure = doorApprovalViaNeeds(needsDir: d, timeout: 0.3, twin: { _, _ in ("Allow once", 0.6) })
        XCTAssertEqual("\(unsure(caller, "reminders.open"))", "\(DoorDecision.no)")
        let gone = doorApprovalViaNeeds(needsDir: d, timeout: 0.3, twin: { _, _ in nil })
        XCTAssertEqual("\(gone(caller, "reminders.open"))", "\(DoorDecision.no)")
        let rows = DecisionLog.recent(10)
        XCTAssertEqual(rows.map { $0["by"] as? String }, ["twin", "default", "default"])
        XCTAssertEqual(rows.first?["confidence"] as? Double, 0.86)
        let fyi = (try? FileManager.default.contentsOfDirectory(atPath: d.path))?.filter { $0.hasPrefix("twin-") } ?? []
        XCTAssertEqual(fyi.count, 1, "one quiet FYI for the stream")
    }
}
