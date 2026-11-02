import XCTest
@testable import OpenRappterCore

@MainActor
final class NeedsTests: XCTestCase {
    func tempDir() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("needs-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    func testAddAnswerLater() {
        let q = NeedsQueue(dir: tempDir())
        XCTAssertNil(q.top)
        let a = Need(id: "a", title: "Approve the thing?", opts: [NeedOption(label: "Yes", rec: true, action: "allow"), NeedOption(label: "No", action: "deny")], created: 1)
        let b = Need(id: "b", title: "Later one", opts: [NeedOption(label: "OK")], created: 2)
        q.add(b); q.add(a)
        XCTAssertEqual(q.needs.map(\.id), ["a", "b"], "oldest first")
        q.answer(a, a.opts[0])
        XCTAssertEqual(q.top?.id, "b")
        let ans = try! JSONDecoder().decode(NeedAnswer.self, from: Data(contentsOf: q.dir.appendingPathComponent("a.answer.json")))
        XCTAssertEqual(ans.action, "allow"); XCTAssertEqual(ans.label, "Yes")
        q.later(b)
        XCTAssertNil(q.top)
        // A reload after an answer file appears from outside (the hook, a script) also clears the card.
        let c = Need(id: "c", title: "From a script", opts: [NeedOption(label: "OK")], created: 3)
        q.add(c); XCTAssertEqual(q.top?.id, "c")
        try! "{\"id\":\"c\",\"label\":\"OK\",\"answered\":1}".write(to: q.dir.appendingPathComponent("c.answer.json"), atomically: true, encoding: .utf8)
        q.reload(); XCTAssertNil(q.top)
    }

    func testTowerShapeDecodes() throws {
        let json = #"{"id":"m1","title":"Ship the deck?","ctx":"Three slides changed","opts":[{"label":"Ship","rec":true,"action":"ship"},{"label":"Hold","action":"hold"}]}"#
        let n = try JSONDecoder().decode(Need.self, from: Data(json.utf8))
        XCTAssertEqual(n.opts.count, 2); XCTAssertEqual(n.opts[0].rec, true); XCTAssertNil(n.created)
    }

    func testDoorCardsJumpTheQueue() {
        let q = NeedsQueue(dir: tempDir())
        q.add(Need(id: "old", title: "Claude finished", opts: [NeedOption(label: "OK")], source: "claude-code", created: 1))
        q.add(Need(id: "door", title: "beam wants to reminders.open", opts: [NeedOption(label: "No")], source: "doors", created: 9))
        XCTAssertEqual(q.top?.id, "door")
    }

    /// Object, don't confirm: an old FYI card clears itself; only the newest "finished" per session shows.
    @MainActor func testIdleCardsTakeTheirDefault() {
        let d = URL(fileURLWithPath: "/tmp/nd-\(UUID().uuidString.prefix(6))")
        let q = NeedsQueue(dir: d)
        let now = Date().timeIntervalSince1970
        q.add(Need(id: "cc-s1-done-1", title: "old", opts: [NeedOption(label: "OK", rec: true)], source: "claude-code", created: now - 5))
        q.add(Need(id: "cc-s1-done-2", title: "new", opts: [NeedOption(label: "OK", rec: true)], source: "claude-code", created: now))
        q.add(Need(id: "fyi", title: "stale", opts: [NeedOption(label: "OK")], source: "x", created: now - 60))
        q.add(Need(id: "pick", title: "choice", opts: [NeedOption(label: "A", rec: true), NeedOption(label: "B")], source: "x", created: now - 60))
        XCTAssertEqual(q.needs.map(\.id).sorted(), ["cc-s1-done-2", "pick"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: d.appendingPathComponent("fyi.answer.json").path))
    }
}
