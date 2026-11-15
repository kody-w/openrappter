import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorFitTests: XCTestCase {
    func tempDoor() -> Door {
        let d = Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
        d.fitWords = { _ in ["StaticText: Orders @10,10", "Button: Save @40,300", "Button: Share @90,300", "Button: Cancel @140,300"] }
        return d
    }

    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }

    func answer(_ id: String, in door: Door) throws -> DoorAnswer {
        try JSONDecoder().decode(DoorAnswer.self, from: Data(contentsOf: door.dir.appendingPathComponent("\(id).answer.json")))
    }

    /// Three steps that could only ever act on an app that cannot exist.
    func steps() -> [DoorAsk] {
        ["Orders", "File", "Export"].map { var s = DoorAsk(id: "", do: "press"); s.title = $0; s.app = "NoSuchAppForTests"; return s }
    }

    func learn(_ name: String, in door: Door) async throws {
        var l = DoorAsk(id: "learn-\(UUID().uuidString)", do: "learn"); l.title = name; l.steps = steps()
        try drop(l, in: door)
        await door.drain()
    }

    func stopped(_ name: String, step: Int = 3, why: String = "nothing on screen says Export", at: Double = 1_800_000_000) -> DoorAnswer {
        DoorAnswer(id: "x", ok: false, said: "\(name) stopped at step \(step): \(why)", front: nil, words: nil, picture: nil, at: at)
    }

    func notices(_ door: Door) -> [String] {
        ((try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").split(separator: "\n")
            .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            .filter { ($0["id"] as? String ?? "").contains("-fit-") }.compactMap { $0["said"] as? String }
    }

    // MARK: the decision

    func testAMissingButtonOrAppMeansTheJobNoLongerFits() {
        let a = Door.misfit("export orders stopped at step 3: nothing on screen says Export")
        XCTAssertEqual(a?.step, 3); XCTAssertEqual(a?.reason, "I could not find Export")
        XCTAssertEqual(Door.misfit("j stopped at step 1: that app is not running")?.reason, "the app it needs is not open")
        XCTAssertEqual(Door.misfit("j stopped at step 2: Mail is not open, so I did not touch anything")?.reason, "Mail is not open")
        XCTAssertEqual(Door.misfit("j stopped at step 12: could not bring Mail to the front, so I did not touch anything")?.reason, "I could not bring Mail to the front")
        XCTAssertEqual(Door.misfit("j stopped at step 1: could not find Numbers")?.reason, "I could not find Numbers")
        XCTAssertEqual(Door.misfit("j stopped at step 12: could not find Numbers")?.step, 12)
    }

    func testARefusalOrAWaitIsNotAMisfit() {
        for said in ["j stopped before step 2: hands off",
                     "hands off is on, so I did not do that. Ask resume to let me work again.",
                     "j stopped at step 1: not allowed to press yet",
                     "j stopped at step 1: not allowed to press keys yet",
                     "j stopped at step 2: do not know that key",
                     "j stopped at step 2: found Export but could not press it",
                     "j stopped at step 2: press needs the words on the button",
                     "j stopped at step 2: quitting needs the app named, so I did not press it",
                     "j stopped at step 2: hands off is on, so I did not do that. Ask resume to let me work again.",
                     "j: 3 steps done", "I have not learned j", "",
                     "j stopped at step two: nothing on screen says Export",
                     "j stopped at step 0: nothing on screen says Export",
                     "j stopped at step 2: nothing on screen says ",
                     "j stopped at step 2:  is not open, so I did not touch anything",
                     "j stopped at step 2"] {
            XCTAssertNil(Door.misfit(said), said)
        }
    }

    func testOnlyButtonNamesAreOfferedAndAtMostSix() {
        let words = ["StaticText: Title @1,1", "Button: Save @40,300", "Button: Save @80,300", "Button: close button @5,5", "Button:  @9,9",
                     "CheckBox: Remember (on) @3,3", "Button: Meet @ noon", "Button: B", "Button: C", "Button: D", "Button: E", "Button: F"]
        XCTAssertEqual(Door.offered(words), ["Save", "Meet @ noon", "B", "C", "D", "E"])
        XCTAssertEqual(Door.offered([]), [])
        XCTAssertEqual(Door.offered(words, limit: 1), ["Save"])
    }

    func testTheSentenceIsPlain() {
        var m = DoorMisfit(job: "export orders", at: 1, step: 3, reason: "I could not find Export", saw: ["Save", "Share", "Cancel"], steps: "")
        XCTAssertEqual(Door.fitSays(m), "export orders no longer fits this Mac: at step 3 I could not find Export. I can see: Save, Share, Cancel.")
        m.saw = []
        XCTAssertEqual(Door.fitSays(m), "export orders no longer fits this Mac: at step 3 I could not find Export.")
    }

    // MARK: marking, skipping, clearing

    func testAJobThatStopsFittingIsMarkedAndSaidOnce() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        let before = try Data(contentsOf: door.learnedURL("export orders")!)
        var asked: [String?] = []
        let words = door.fitWords
        door.fitWords = { asked.append($0); return words($0) }
        door.fitAfter("export orders", steps(), stopped("export orders"))
        let m = try XCTUnwrap(door.misfit(of: "Export Orders"))
        XCTAssertEqual(m.step, 3); XCTAssertEqual(m.reason, "I could not find Export"); XCTAssertEqual(m.saw, ["Save", "Share", "Cancel"])
        XCTAssertEqual(m.at, 1_800_000_000)
        XCTAssertEqual(asked, ["NoSuchAppForTests"])
        XCTAssertTrue(door.fitSkips("export orders"))
        XCTAssertEqual(notices(door).count, 1)
        XCTAssertTrue(notices(door)[0].hasPrefix("export orders no longer fits this Mac: at step 3 I could not find Export. I can see: Save, Share, Cancel."))
        // Trying again and failing again keeps the mark fresh but is not said a second time.
        door.fitAfter("export orders", steps(), stopped("export orders", step: 2, why: "nothing on screen says File", at: 1_800_000_500))
        XCTAssertEqual(door.misfit(of: "export orders")?.step, 2)
        XCTAssertEqual(notices(door).count, 1)
        // The old steps are untouched, and the mark is not listed as a job.
        XCTAssertEqual(try Data(contentsOf: door.learnedURL("export orders")!), before)
        try drop(DoorAsk(id: "j0", do: "jobs"), in: door)
        await door.drain()
        XCTAssertEqual(try answer("j0", in: door).words, ["export orders"])
    }

    func testARefusalOrAnUnknownJobLeavesNoMark() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders", why: "not allowed to press yet"))
        door.fitAfter("export orders", steps(), DoorAnswer(id: "x", ok: false, said: "export orders stopped before step 1: hands off", front: nil, words: nil, picture: nil, at: 1))
        XCTAssertNil(door.misfit(of: "export orders"))
        // A mark for a job with no steps kept does not count.
        door.fitAfter("never learned", steps(), stopped("never learned"))
        XCTAssertFalse(door.fitSkips("never learned"))
        XCTAssertTrue(notices(door).filter { $0.hasPrefix("export") }.isEmpty)
    }

    func testAnAppThatIsNotOpenIsNamedAndNothingIsSeen() async throws {
        let door = tempDoor()
        door.fitWords = { _ in [] }
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders", step: 1, why: "that app is not running"))
        let m = try XCTUnwrap(door.misfit(of: "export orders"))
        XCTAssertEqual(Door.fitSays(m), "export orders no longer fits this Mac: at step 1 NoSuchAppForTests is not open.")
        // A step number past the end of the job still marks it, with nothing seen.
        door.fitAfter("export orders", steps(), stopped("export orders", step: 9))
        XCTAssertEqual(door.misfit(of: "export orders")?.step, 9)
    }

    func testADueWatchSkipsAJobThatNoLongerFits() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        try await learn("tidy up", in: door)
        let all = [DoorWatch(title: "hourly export", job: "Export Orders", see: nil, app: nil, at: nil, every: 60, cover: true, on: nil),
                   DoorWatch(title: "hourly tidy", job: "tidy up", see: nil, app: nil, at: nil, every: 60, cover: nil, on: nil)]
        let due = Door.due(all, now: Date(), fired: [:], onScreen: [], lit: [])
        XCTAssertEqual(due.count, 2)
        XCTAssertEqual(door.fitRunnable(due).count, 2)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        XCTAssertEqual(door.fitRunnable(due).map(\.title), ["hourly tidy"])
        XCTAssertTrue(door.fitSkips("Export Orders")); XCTAssertFalse(door.fitSkips("tidy up"))
        XCTAssertEqual(Door.runnable(due, misfits: ["tidy-up"]) { door.slug($0) }.map(\.title), ["hourly export"])
        XCTAssertEqual(Door.runnable(due, misfits: []) { door.slug($0) }.count, 2)
    }

    func testARunThatGoesThroughClearsTheMark() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        XCTAssertTrue(door.fitSkips("export orders"))
        door.fitAfter("export orders", steps(), DoorAnswer(id: "x", ok: true, said: "export orders: 3 steps done", front: nil, words: nil, picture: nil, at: 2))
        XCTAssertFalse(door.fitSkips("export orders"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.fitURL.path))
        // It can stop fitting again later, and that is said again.
        door.fitAfter("export orders", steps(), stopped("export orders", at: 1_800_009_000))
        XCTAssertEqual(notices(door).count, 2)
    }

    func testARealRunOfAJobGoesThroughTheSameCheck() async throws {
        // An app that cannot be found on any Mac: the open step fails without touching anything.
        let door = tempDoor()
        var l = DoorAsk(id: "l1", do: "learn"); l.title = "open the thing"
        var s = DoorAsk(id: "", do: "open"); s.text = "NoSuchAppForTests"; l.steps = [s]
        try drop(l, in: door)
        var j = DoorAsk(id: "j1", do: "job"); j.title = "open the thing"
        try drop(j, in: door)
        await door.drain()
        XCTAssertEqual(try answer("j1", in: door).said, "open the thing stopped at step 1: could not find NoSuchAppForTests")
        XCTAssertEqual(door.misfit(of: "open the thing")?.reason, "I could not find NoSuchAppForTests")
        XCTAssertEqual(notices(door).count, 1)
    }

    func testShowingItAgainAndSayingYesClearsTheMark() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        // What "shown" leaves behind: new steps waiting for a yes.
        var fresh = DoorAsk(id: "", do: "press"); fresh.title = "Export as"; fresh.app = "NoSuchAppForTests"
        let url = door.learnedURL("export orders")!
        try JSONEncoder().encode([fresh]).write(to: url.deletingLastPathComponent().appendingPathComponent(".draft-" + url.lastPathComponent))
        var no = DoorAsk(id: "y0", do: "yes"); no.title = "some other job"
        try drop(no, in: door)
        await door.drain()
        XCTAssertTrue(door.fitSkips("export orders"), "a yes for another job changes nothing")
        var yes = DoorAsk(id: "y1", do: "yes"); yes.title = "export orders"
        try drop(yes, in: door)
        await door.drain()
        XCTAssertTrue(try answer("y1", in: door).ok)
        XCTAssertFalse(door.fitSkips("export orders"))
        XCTAssertEqual(try JSONDecoder().decode([DoorAsk].self, from: Data(contentsOf: url)).map(\.title), ["Export as"])
    }

    func testLearningNewStepsAnotherWayAlsoClearsTheMark() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        var l = DoorAsk(id: "l9", do: "learn"); l.title = "export orders"; l.steps = Array(steps().prefix(2))
        try drop(l, in: door)
        await door.drain()
        XCTAssertFalse(door.fitSkips("export orders"))
    }

    // MARK: the page

    func testThePageLeavesARowWithThreeButtons() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        _ = door.writePage(hours: 24)
        let says = "export orders no longer fits this Mac: at step 3 I could not find Export. I can see: Save, Share, Cancel."
        let page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertTrue(page.contains(says))
        for label in ["Show it again", "Try it again", "Leave it"] { XCTAssertTrue(page.contains(">\(label)</a>"), label) }
        XCTAssertFalse(page.contains(".json") || page.contains("learned/"), "no file names on the page")
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        let rows = left["left"] as! [[String: Any]]
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0]["says"] as? String, says)
        let choices = rows[0]["choices"] as! [[String: String]]
        XCTAssertEqual(choices.map { $0["label"] }, ["Show it again", "Try it again", "Leave it"])
        let offers = try JSONDecoder().decode([String: [DoorAsk]].self, from: Data(contentsOf: door.dir.appendingPathComponent("offers.json")))["offers"]!
        let byKey = Dictionary(uniqueKeysWithValues: offers.map { ($0.id, $0) })
        let asks = choices.map { byKey[$0["offer"]!]! }
        XCTAssertEqual(asks.map(\.do), ["show", "job", "forget"])
        XCTAssertEqual(asks[0].title, "export orders"); XCTAssertEqual(asks[1].title, "export orders")
    }

    func testAJobThatFitsLeavesNothingOnThePage() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        _ = door.writePage(hours: 24)
        let page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertFalse(page.contains("no longer fits"))
        XCTAssertTrue(page.contains("Nothing. You do not need to do anything."))
    }

    func testAStoppedJobIsShownOnceNotTwice() async throws {
        let door = tempDoor()
        var l = DoorAsk(id: "l1", do: "learn"); l.title = "open the thing"
        var s = DoorAsk(id: "", do: "open"); s.text = "NoSuchAppForTests"; l.steps = [s]
        try drop(l, in: door)
        var j = DoorAsk(id: "j1", do: "job"); j.title = "open the thing"
        try drop(j, in: door)
        await door.drain()
        _ = door.writePage(hours: 24)
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        let rows = left["left"] as! [[String: Any]]
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue((rows[0]["says"] as? String ?? "").hasPrefix("open the thing no longer fits this Mac"))
    }

    func testLeaveItHidesTheRowButWatchesStillSkip() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        door.fitAfter("export orders", steps(), stopped("export orders"))
        _ = door.writePage(hours: 24)
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        let leave = ((left["left"] as! [[String: Any]])[0]["choices"] as! [[String: String]]).first { $0["label"] == "Leave it" }!
        XCTAssertTrue(door.take(token: left["token"] as! String, key: leave["offer"]!))
        await door.drain()
        _ = door.writePage(hours: 24)
        let after = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        XCTAssertEqual((after["left"] as! [[String: Any]]).count, 0)
        // The row and its buttons go; the one-time note under "What I noticed" stays as history.
        let page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertFalse(page.contains(">Show it again</a>") || page.contains(">Leave it</a>"))
        XCTAssertTrue(page.contains("Left for you <em>0</em>"))
        XCTAssertTrue(door.fitSkips("export orders"), "the mark stays, so watches still skip it")
        XCTAssertTrue(door.fitRows().isEmpty)
        // If it is tried again and stops again, it is worth saying again.
        door.fitAfter("export orders", steps(), stopped("export orders", at: 1_800_000_900))
        XCTAssertEqual(door.fitRows().count, 1)
    }

    // MARK: the ask

    func testFitsListsEveryJobAndWhy() async throws {
        let door = tempDoor()
        try drop(DoorAsk(id: "f0", do: "fits"), in: door)
        await door.drain()
        XCTAssertTrue(try answer("f0", in: door).ok)
        XCTAssertEqual(try answer("f0", in: door).said, "I have not learned any jobs yet")
        try await learn("export orders", in: door)
        try await learn("tidy up", in: door)
        try drop(DoorAsk(id: "f1", do: "fits"), in: door)
        await door.drain()
        XCTAssertEqual(try answer("f1", in: door).said, "all 2 jobs I know still fit this Mac")
        XCTAssertEqual(try answer("f1", in: door).words, ["export orders: fits", "tidy up: fits"])
        door.fitAfter("export orders", steps(), stopped("export orders"))
        try drop(DoorAsk(id: "f2", do: "fits"), in: door)
        await door.drain()
        let got = try answer("f2", in: door)
        XCTAssertEqual(got.said, "1 of the 2 jobs I know no longer fits this Mac")
        XCTAssertEqual(got.words, ["export orders: does not fit. At step 3 I could not find Export. I can see: Save, Share, Cancel", "tidy up: fits"])
        XCTAssertEqual(Door.line(DoorAsk(id: "", do: "fits")), "checking which jobs still fit this Mac")
    }

    func testABrokenMarkFileIsTreatedAsNoMarks() async throws {
        let door = tempDoor()
        try await learn("export orders", in: door)
        try Data("not a list".utf8).write(to: door.fitURL)
        XCTAssertTrue(door.misfits().isEmpty)
        XCTAssertFalse(door.fitSkips("export orders"))
        door.fitAfter("export orders", steps(), stopped("export orders"))
        XCTAssertTrue(door.fitSkips("export orders"))
    }
}
