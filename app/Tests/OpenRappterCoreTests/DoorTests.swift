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

    func testHandsOffStopsEveryActingAskUntilResume() async throws {
        let door = tempDoor()
        try drop(DoorAsk(id: "h1", do: "hold"), in: door)
        var open = DoorAsk(id: "h2", do: "open"); open.text = "Nothing-here"
        try drop(open, in: door)
        await door.drain()
        XCTAssertTrue(door.held)
        XCTAssertTrue(try answer("h2", in: door).said.hasPrefix("hands off is on"))
        try drop(DoorAsk(id: "h3", do: "resume"), in: door)
        var again = DoorAsk(id: "h4", do: "open"); again.text = "Nothing-here"
        try drop(again, in: door)
        await door.drain()
        XCTAssertFalse(door.held)
        XCTAssertEqual(try answer("h4", in: door).said, "could not find Nothing-here")
    }

    func testAWatchNeedsALearnedJobAndIsDueOnASightOrAClock() async throws {
        let door = tempDoor()
        var w0 = DoorAsk(id: "w0", do: "watch"); w0.title = "morning"; w0.job = "open report"; w0.at = "07:30"
        try drop(w0, in: door)
        var learn = DoorAsk(id: "w1", do: "learn"); learn.title = "open report"
        var step = DoorAsk(id: "", do: "key"); step.key = "escape"; learn.steps = [step]
        try drop(learn, in: door)
        var w2 = DoorAsk(id: "w2", do: "watch"); w2.title = "morning"; w2.job = "open report"; w2.at = "07:30"
        try drop(w2, in: door)
        var w3 = DoorAsk(id: "w3", do: "watch"); w3.title = "later box"; w3.job = "open report"; w3.see = "Quit & Reopen"
        try drop(w3, in: door)
        await door.drain()
        XCTAssertFalse(try answer("w0", in: door).ok)
        XCTAssertTrue(try answer("w2", in: door).ok)
        let all = door.watches()
        XCTAssertEqual(all.count, 2)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let seven = cal.date(from: DateComponents(year: 2026, month: 11, day: 15, hour: 7, minute: 0))!
        let nine = cal.date(from: DateComponents(year: 2026, month: 11, day: 15, hour: 9, minute: 0))!
        XCTAssertEqual(Door.due(all, now: seven, fired: [:], onScreen: [], lit: [], calendar: cal).map(\.title), [])
        XCTAssertEqual(Door.due(all, now: nine, fired: [:], onScreen: [], lit: [], calendar: cal).map(\.title), ["morning"])
        XCTAssertEqual(Door.due(all, now: nine, fired: ["morning": seven.timeIntervalSince1970 + 1800], onScreen: [], lit: [], calendar: cal).map(\.title), [])
        XCTAssertEqual(Door.due(all, now: seven, fired: [:], onScreen: ["Button: Quit & Reopen"], lit: [], calendar: cal).map(\.title), ["later box"])
        XCTAssertEqual(Door.due(all, now: seven, fired: [:], onScreen: ["Button: Quit & Reopen"], lit: ["later box"], calendar: cal).map(\.title), [])
    }

    func testABoxThatSitsIsNoticedOnceAndLandsOnThePage() async throws {
        let door = tempDoor()
        door.boxPatience = 60
        let t0 = Date()
        let box = [(app: "Installer", words: ["StaticText: Allow this?", "Button: Allow", "Button: Later"])]
        door.noticeBoxes(box, now: t0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("waiting.json").path))
        let moved = [(app: "Installer", words: ["StaticText: Allow this now?", "Button: Allow", "Button: Later"])]
        door.noticeBoxes(moved, now: t0.addingTimeInterval(30))
        door.noticeBoxes(box, now: t0.addingTimeInterval(61))
        door.noticeBoxes(box, now: t0.addingTimeInterval(90))
        let log = try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)
        XCTAssertEqual(log.components(separatedBy: "a box from Installer").count - 1, 1)
        try drop(DoorAsk(id: "p1", do: "page"), in: door)
        await door.drain()
        let page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertTrue(page.contains("Installer is asking: Allow this?"))
        XCTAssertTrue(page.contains("Left for you <em>1</em>"))
        XCTAssertTrue(page.contains(">Press Allow</a>") && page.contains(">Press Later</a>"))
        // A click with the wrong token does nothing; the right one drops the offered ask and uses the offer up.
        let offers = try JSONDecoder().decode([String: [DoorAsk]].self, from: Data(contentsOf: door.dir.appendingPathComponent("offers.json")))
        let token = offers["token"]![0].id
        door.clicked(URL(string: "openrappter://pick/wrong/o1")!)
        XCTAssertTrue(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("offers.json").path))
        door.clicked(URL(string: "openrappter://pick/\(token)/o2")!)
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("offers.json").path))
        let dropped = try FileManager.default.contentsOfDirectory(atPath: door.dir.path).filter { $0.hasPrefix("pick-") && !$0.contains("answer") }
        XCTAssertEqual(dropped.count, 1)
        XCTAssertEqual(try JSONDecoder().decode(DoorAsk.self, from: Data(contentsOf: door.dir.appendingPathComponent(dropped[0]))).title, "Later")
        door.noticeBoxes([], now: t0.addingTimeInterval(120))
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("waiting.json").path))
    }

    func testAPackIsPlainAsksAnotherDoorLearnsOnArrival() async throws {
        let a = tempDoor(), b = tempDoor()
        var learn = DoorAsk(id: "k1", do: "learn"); learn.title = "wake the screen"
        var step = DoorAsk(id: "", do: "key"); step.key = "escape"; learn.steps = [step]
        try drop(learn, in: a)
        var w = DoorAsk(id: "k2", do: "watch"); w.title = "hourly"; w.job = "wake the screen"; w.every = 60
        try drop(w, in: a)
        try drop(DoorAsk(id: "k3", do: "pack"), in: a)
        await a.drain()
        XCTAssertTrue(try answer("k3", in: a).said.hasPrefix("packed 1 jobs and 1 watches"))
        for f in try FileManager.default.contentsOfDirectory(at: a.dir.appendingPathComponent("pack"), includingPropertiesForKeys: nil) {
            try FileManager.default.copyItem(at: f, to: b.dir.appendingPathComponent(f.lastPathComponent))
        }
        try drop(DoorAsk(id: "k4", do: "jobs"), in: b)
        await b.drain()
        XCTAssertEqual(try answer("k4", in: b).words, ["wake the screen"])
        XCTAssertEqual(b.watches().map(\.title), ["hourly"])
    }

    func testShownKeysBecomeKeyStepsOnlyForNamedKeysAndShortcuts() {
        XCTAssertNil(Door.step(forKey: nil, bare: "a", mods: [], shift: false))
        XCTAssertEqual(Door.step(forKey: "return", bare: nil, mods: [], shift: false)?.key, "return")
        let q = Door.step(forKey: nil, bare: "q", mods: ["command"], shift: false)
        XCTAssertEqual(q?.key, "q"); XCTAssertEqual(q?.with, ["command"])
    }

    func testAKeyMeantForAnAppIsNeverSentToWhateverIsInFront() async throws {
        let door = tempDoor()
        var q = DoorAsk(id: "q1", do: "key"); q.key = "q"; q.with = ["command"]; q.app = "No Such App 123"
        try drop(q, in: door)
        var bare = DoorAsk(id: "q2", do: "key"); bare.key = "q"; bare.with = ["command"]
        try drop(bare, in: door)
        await door.drain()
        XCTAssertEqual(try answer("q1", in: door).said, "No Such App 123 is not open, so I did not touch anything")
        XCTAssertEqual(try answer("q2", in: door).said, "quitting needs the app named, so I did not press it")
    }

    func testHandsOffCanBeSaidOutLoud() {
        XCTAssertEqual(Door.spoken("Rappter, hands off."), "hold")
        XCTAssertEqual(Door.spoken("Hands back on"), "resume")
        XCTAssertNil(Door.spoken("take my hands off the wheel"))
        let door = tempDoor(); door.hold(); XCTAssertTrue(door.held); door.release(); XCTAssertFalse(door.held)
    }
}
