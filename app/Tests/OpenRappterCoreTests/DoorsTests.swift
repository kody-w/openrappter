import XCTest
import Darwin
@testable import OpenRappterCore

final class DoorsTests: XCTestCase {
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
        XCTAssertThrowsError(try MacDoors.recentMessages(since: 0, limit: 1, db: d.appendingPathComponent("none.db").path))
    }
}
