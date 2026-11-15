import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorTests: XCTestCase {
    func tempDoor() -> Door {
        Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
    }

    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }

    func answer(_ id: String, in door: Door) throws -> DoorAnswer {
        try JSONDecoder().decode(DoorAnswer.self, from: Data(contentsOf: door.dir.appendingPathComponent("\(id).answer.json")))
    }

    func testAnAskGetsOneAnswerAndIsNotRunTwice() async throws {
        let door = tempDoor()
        try drop(DoorAsk(id: "a1", do: "dance"), in: door)
        var acted: [String] = []
        door.onAct = { acted.append($0) }
        await door.drain()
        await door.drain()
        let got = try answer("a1", in: door)
        XCTAssertFalse(got.ok)
        XCTAssertTrue(got.said.contains("do not know"))
        XCTAssertEqual(acted.count, 1)
        XCTAssertTrue(door.waiting().isEmpty)
    }

    func testTheLogNeverHoldsWhatWasTyped() async throws {
        let door = tempDoor()
        var ask = DoorAsk(id: "t1", do: "type"); ask.text = "a private thing"
        XCTAssertEqual(Door.line(ask), "typing 15 characters")
        var press = DoorAsk(id: "p1", do: "press"); press.title = "Allow"
        XCTAssertEqual(Door.line(press), "pressing Allow")
    }

    func testAskWithMissingPartsSaysSoPlainly() async throws {
        let door = tempDoor()
        try drop(DoorAsk(id: "c1", do: "click"), in: door)
        try drop(DoorAsk(id: "p1", do: "press"), in: door)
        await door.drain()
        XCTAssertEqual(try answer("c1", in: door).said, "click needs x and y")
        XCTAssertEqual(try answer("p1", in: door).said, "press needs the words on the button")
        let log = try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"))
        XCTAssertEqual(log.split(separator: "\n").count, 2)
    }

    func testTheDoorFolderIsTheOwnersOnly() throws {
        let door = tempDoor()
        let perms = try FileManager.default.attributesOfItem(atPath: door.dir.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(perms?.intValue, 0o700)
    }

    func testKeysAreNamedPlainly() {
        XCTAssertEqual(Screen.keyCode("return"), 36)
        XCTAssertEqual(Screen.keyCode("Escape"), 53)
        XCTAssertNil(Screen.keyCode("banana"))
    }

    func testAJobIsLearnedOnceAndThenDoneByName() async throws {
        let door = tempDoor()
        var learn = DoorAsk(id: "l1", do: "learn"); learn.title = "Open the notes"
        var step = DoorAsk(id: "", do: "open"); step.text = "TextEdit-that-does-not-exist"
        learn.steps = [step]
        try drop(learn, in: door)
        try drop(DoorAsk(id: "j0", do: "jobs"), in: door)
        var job = DoorAsk(id: "j1", do: "job"); job.title = "open the NOTES"
        try drop(job, in: door)
        var missing = DoorAsk(id: "j2", do: "job"); missing.title = "fly"
        try drop(missing, in: door)
        await door.drain()
        XCTAssertEqual(try answer("l1", in: door).said, "learned Open the notes, 1 steps")
        XCTAssertEqual(try answer("j0", in: door).words, ["open the notes"])
        XCTAssertTrue(try answer("j1", in: door).said.hasPrefix("open the NOTES stopped at step 1"))
        XCTAssertEqual(try answer("j2", in: door).said, "I have not learned fly")
    }

    func testAJobCannotHoldAnotherJob() async throws {
        let door = tempDoor()
        var learn = DoorAsk(id: "l2", do: "learn"); learn.title = "loop"
        var inner = DoorAsk(id: "", do: "job"); inner.title = "loop"
        learn.steps = [inner]
        try drop(learn, in: door)
        await door.drain()
        XCTAssertEqual(try answer("l2", in: door).said, "a job cannot hold another job")
    }
}
