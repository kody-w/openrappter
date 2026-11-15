import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorPoliteTests: XCTestCase {
    func tempDoor() -> Door {
        Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
    }
    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }
    func answer(_ id: String, in door: Door) -> DoorAnswer? {
        try? JSONDecoder().decode(DoorAnswer.self, from: Data(contentsOf: door.dir.appendingPathComponent("\(id).answer.json")))
    }
    func left(_ door: Door) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as? [String: Any])
    }

    func testTheDecisionTable() {
        for what in ["press", "click", "type", "key", "open", "job", "always"] {
            XCTAssertEqual(Door.shouldWait(do: what, idle: 0, with: nil, waited: 0), .wait, what)
            XCTAssertEqual(Door.shouldWait(do: what, idle: 19.9, with: nil, waited: 599), .wait, what)
            XCTAssertEqual(Door.shouldWait(do: what, idle: 20, with: nil, waited: 0), .go, what)
            XCTAssertEqual(Door.shouldWait(do: what, idle: 3, with: ["now"], waited: 0), .go, what)
            XCTAssertEqual(Door.shouldWait(do: what, idle: 3, with: nil, waited: 600), .giveUp(Door.gaveUp), what)
        }
        for what in ["look", "jobs", "watches", "boxes", "page", "learn", "hold", "resume", "question", "dance"] {
            XCTAssertEqual(Door.shouldWait(do: what, idle: 0, with: nil, waited: 9999), .go, what)
        }
        // A shortcut keeps its own keys and can still say now. Idle wins over a long wait. A broken reading never blocks.
        XCTAssertEqual(Door.shouldWait(do: "key", idle: 1, with: ["command", "NOW"], waited: 0), .go)
        XCTAssertEqual(Door.shouldWait(do: "key", idle: 1, with: ["command"], waited: 0), .wait)
        XCTAssertEqual(Door.shouldWait(do: "press", idle: 500, with: nil, waited: 5000), .go)
        XCTAssertEqual(Door.shouldWait(do: "press", idle: .nan, with: nil, waited: 0), .go)
        XCTAssertEqual(Door.shouldWait(do: "press", idle: .infinity, with: nil, waited: 0), .go)
        XCTAssertEqual(Door.gaveUp, "you were using this Mac, so I did not interrupt. Ask again when you are done.")
        XCTAssertEqual(Door.waitingLine(0), "")
        XCTAssertEqual(Door.waitingLine(1), "Waiting for you to finish before I do 1 thing.")
        XCTAssertEqual(Door.waitingLine(2), "Waiting for you to finish before I do 2 things.")
        XCTAssertGreaterThanOrEqual(Door.hardwareIdle(), 0)
    }

    func testAnActingAskWaitsThenRunsWhenTheOwnerStops() async throws {
        let door = tempDoor()
        var idle = 2.0
        door.ownerIdle = { idle }
        var acted = 0
        door.onAct = { _ in acted += 1 }
        try drop(DoorAsk(id: "p1", do: "press"), in: door)
        await door.drain()
        await door.drain()
        XCTAssertNil(answer("p1", in: door))
        XCTAssertEqual(acted, 0)
        XCTAssertEqual(door.politeCount(), 1)
        XCTAssertEqual(door.waiting().map(\.id), ["p1"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("log.jsonl").path))
        idle = 45
        await door.drain()
        XCTAssertEqual(answer("p1", in: door)?.said, "press needs the words on the button")
        XCTAssertEqual(acted, 1)
        XCTAssertEqual(door.politeCount(), 0)
    }

    func testNowSkipsTheWaitAndSoDoesAButtonTheOwnerPressed() async throws {
        let door = tempDoor()
        door.ownerIdle = { 0 }
        var now = DoorAsk(id: "c1", do: "click"); now.with = ["now"]
        try drop(now, in: door)
        try drop(DoorAsk(id: "pick-1-o1", do: "press"), in: door)
        try drop(DoorAsk(id: "c2", do: "click"), in: door)
        await door.drain()
        XCTAssertEqual(answer("c1", in: door)?.said, "click needs x and y")
        XCTAssertEqual(answer("pick-1-o1", in: door)?.said, "press needs the words on the button")
        XCTAssertNil(answer("c2", in: door))
        XCTAssertEqual(door.politeCount(), 1)
    }

    func testAReadingAskBehindAWaitingPressStillGetsAnswered() async throws {
        let door = tempDoor()
        door.ownerIdle = { 1 }
        try drop(DoorAsk(id: "p1", do: "press"), in: door)
        try await Task.sleep(for: .milliseconds(20))
        try drop(DoorAsk(id: "j1", do: "jobs"), in: door)
        try drop(DoorAsk(id: "d1", do: "dance"), in: door)
        XCTAssertEqual(door.waiting().first?.id, "p1")
        await door.drain()
        XCTAssertNil(answer("p1", in: door))
        XCTAssertEqual(answer("j1", in: door)?.said, "I know 0 jobs")
        XCTAssertNotNil(answer("d1", in: door))
        XCTAssertEqual(door.waiting().map(\.id), ["p1"])
    }

    func testItGivesUpAfterTenMinutesWithAPlainLine() async throws {
        let door = tempDoor()
        door.ownerIdle = { 5 }
        var t = Date(timeIntervalSince1970: 1_800_000_000)
        door.clock = { t }
        var done = 0
        door.onDone = { done += 1 }
        try drop(DoorAsk(id: "o1", do: "open"), in: door)
        await door.drain()
        t = t.addingTimeInterval(599)
        await door.drain()
        XCTAssertNil(answer("o1", in: door))
        t = t.addingTimeInterval(1)
        await door.drain()
        let got = try XCTUnwrap(answer("o1", in: door))
        XCTAssertFalse(got.ok)
        XCTAssertEqual(got.said, "you were using this Mac, so I did not interrupt. Ask again when you are done.")
        XCTAssertEqual(done, 1)
        XCTAssertEqual(door.politeCount(), 0)
        XCTAssertTrue(door.waiting().isEmpty)
        let log = try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)
        XCTAssertEqual(log.split(separator: "\n").count, 1)
        XCTAssertTrue(log.contains("did not interrupt"))
        await door.drain()
        XCTAssertEqual(try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8).split(separator: "\n").count, 1)
    }

    func testThePageSaysItIsWaitingAndStopsSayingSo() async throws {
        let door = tempDoor()
        var idle = 3.0
        door.ownerIdle = { idle }
        try drop(DoorAsk(id: "pg", do: "page"), in: door)
        await door.drain()
        func page() throws -> String { try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8) }
        XCTAssertFalse(try page().contains("Waiting for you to finish"))
        XCTAssertEqual(try left(door)["waiting"] as? Int, 0)
        try drop(DoorAsk(id: "p1", do: "press"), in: door)
        try drop(DoorAsk(id: "k1", do: "key"), in: door)
        await door.drain()
        XCTAssertTrue(try page().contains("<p class=\"sub\">Waiting for you to finish before I do 2 things.</p>"))
        XCTAssertEqual(try left(door)["waiting"] as? Int, 2)
        // One is taken back by the person who asked: the count follows.
        try FileManager.default.removeItem(at: door.dir.appendingPathComponent("k1.json"))
        await door.drain()
        XCTAssertTrue(try page().contains("Waiting for you to finish before I do 1 thing."))
        idle = 60
        await door.drain()
        XCTAssertFalse(try page().contains("Waiting for you to finish"))
        XCTAssertEqual(try left(door)["waiting"] as? Int, 0)
        XCTAssertNotNil(answer("p1", in: door))
    }

    func testAJobTheDoorStartsItselfWaitsItsTurnToo() async throws {
        let door = tempDoor()
        var idle = 4.0
        door.ownerIdle = { idle }
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        door.clock = { t }
        var job = DoorAsk(id: "watch-1-morning", do: "job"); job.title = "NoSuchJobForTests"
        XCTAssertTrue(door.parked(job, now: t))
        XCTAssertEqual(door.waiting().map(\.id), ["watch-1-morning"])
        XCTAssertEqual(door.politeCount(), 1)
        await door.drain()
        XCTAssertNil(answer("watch-1-morning", in: door))
        // A standing answer and a covered job arrive as plain asks in the folder, so they wait the same way.
        try drop(DoorAsk(id: "always-1-1", do: "press"), in: door)
        var cover = DoorAsk(id: "cover-1-x", do: "job"); cover.title = "NoSuchJobForTests"
        try drop(cover, in: door)
        await door.drain()
        XCTAssertEqual(door.politeCount(), 3)
        idle = 30
        await door.drain()
        XCTAssertEqual(answer("watch-1-morning", in: door)?.said, "I have not learned NoSuchJobForTests")
        XCTAssertNotNil(answer("always-1-1", in: door))
        XCTAssertNotNil(answer("cover-1-x", in: door))
        // With the owner away nothing is parked: the job runs where it always did.
        XCTAssertFalse(door.parked(DoorAsk(id: "watch-2-x", do: "job"), now: t))
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("watch-2-x.json").path))
    }

    func testHandsOffAnswersStraightAwayInsteadOfWaiting() async throws {
        let door = tempDoor()
        door.ownerIdle = { 0 }
        door.hold()
        try drop(DoorAsk(id: "p1", do: "press"), in: door)
        await door.drain()
        XCTAssertTrue(answer("p1", in: door)?.said.contains("hands off is on") ?? false)
        XCTAssertEqual(door.politeCount(), 0)
    }

    func testADoorDrivenByHandNeverWaitsAndALiveOneReadsTheRealMac() {
        XCTAssertEqual(tempDoor().ownerIdle(), .infinity)
    }
}
