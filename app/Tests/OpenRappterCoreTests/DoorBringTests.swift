import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorBringTests: XCTestCase {
    func tempDoor() -> Door {
        let d = Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
        // Nothing here may ever look at the real keys or open a real screen.
        d.ownerHere = { true }
        d.openScreen = { _ in XCTFail("a test opened a real screen"); return false }
        return d
    }
    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }
    func log(_ door: Door) -> String { (try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "" }
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testBeatCarriesNeedsOnlyForBoxesThatGuardTheMac() throws {
        let door = tempDoor()
        door.boxPatience = 60
        XCTAssertEqual((door.beat()["needs"] as? [[String: String]])?.count, 0, "no boxes, an empty list")
        let boxes = [(app: "SecurityAgent", words: ["StaticText: NoSuchAppForTests wants to make changes.", "StaticText: Enter your password to allow this.", "Button: Cancel", "Button: OK"]),
                     (app: "NoSuchAppForTests", words: ["StaticText: Save the changes?", "Button: Save", "Button: Later"])]
        door.noticeBoxes(boxes, now: t0)
        XCTAssertEqual((door.beat()["needs"] as? [[String: String]])?.count, 0, "not waiting long enough yet")
        door.noticeBoxes(boxes, now: t0.addingTimeInterval(61))
        let beat = door.beat(now: t0.addingTimeInterval(62))
        let needs = try XCTUnwrap(beat["needs"] as? [[String: String]])
        XCTAssertEqual(needs.count, 1)
        XCTAssertEqual(needs[0]["says"], "NoSuchAppForTests wants to make changes. Enter your password to allow this.")
        XCTAssertEqual(Set(needs[0].keys), ["id", "says"], "nothing but a name and the words: no buttons, no offers")
        // The name stays the same for as long as the box is up.
        door.noticeBoxes(boxes, now: t0.addingTimeInterval(200))
        XCTAssertEqual((door.beat()["needs"] as? [[String: String]])?.first?["id"], needs[0]["id"])
        // Everything else the beat said is still there, and it is still plain data.
        for k in ["schema", "mac", "at", "held", "left", "cover"] { XCTAssertNotNil(beat[k], k) }
        let sent = String(data: try JSONSerialization.data(withJSONObject: beat), encoding: .utf8)!
        XCTAssertFalse(sent.contains("Button") || sent.contains("token") || sent.contains("Save the changes"))
        // The box goes, the need goes.
        door.noticeBoxes([], now: t0.addingTimeInterval(300))
        XCTAssertEqual((door.beat()["needs"] as? [[String: String]])?.count, 0)
    }

    func testNeedsFromOddWaitingLists() {
        XCTAssertEqual(Door.needs(from: []).count, 0)
        XCTAssertEqual(Door.needs(from: [["words": ["StaticText: hi"]], ["app": 7]]).count, 0, "no app named, nothing said")
        let twice: [[String: Any]] = [["app": "NetAuthAgent", "since": 5.0, "words": []], ["app": "NetAuthAgent", "since": 5.0, "words": []],
                                      ["app": "NetAuthAgent", "since": 9.0]]
        let n = Door.needs(from: twice)
        XCTAssertEqual(n.map { $0["id"]! }, ["netauthagent-5", "netauthagent-9"])
        XCTAssertEqual(n[0]["says"], "")
        let long: [[String: Any]] = [["app": "SecurityAgent", "since": 1.0, "words": ["StaticText: " + String(repeating: "x", count: 900)]]]
        XCTAssertEqual(Door.needs(from: long)[0]["says"]!.count, 200)
        for g in Door.gates { XCTAssertEqual(Door.needs(from: [["app": g, "since": 1.0]]).count, 1, g) }
    }

    func testDecidingWhichNeedsToActOn() {
        let long = Date.distantPast
        func go(_ needs: [String], _ opened: Set<String> = [], here: Bool = true, held: Bool = false, last: Date? = nil, now: Date? = nil) -> (act: [String], keep: Set<String>) {
            Door.bringNow(needs: needs, opened: opened, ownerHere: here, held: held, lastOpen: last ?? long, now: now ?? t0)
        }
        XCTAssertEqual(go(["a"]).act, ["a"])
        XCTAssertEqual(go(["a", "b"]).act, ["a", "b"], "two boxes on one Mac are one screen")
        // Once per box.
        XCTAssertEqual(go(["a"], ["a"]).act, [])
        XCTAssertEqual(go(["a", "b"], ["a"]).act, ["b"])
        XCTAssertEqual(go(["a", "a", ""]).act, ["a"])
        // Owner away, or hands off: nothing, and nothing is marked as done.
        XCTAssertEqual(go(["a"], here: false).act, [])
        XCTAssertEqual(go(["a"], here: false).keep, [])
        XCTAssertEqual(go(["a"], held: true).act, [])
        // One screen a minute.
        XCTAssertEqual(go(["a"], last: t0.addingTimeInterval(-59)).act, [])
        XCTAssertEqual(go(["a"], last: t0.addingTimeInterval(-60)).act, ["a"])
        XCTAssertEqual(go(["a"], last: t0.addingTimeInterval(30)).act, [], "a clock that went backwards opens nothing")
        // Forgetting: what the other Mac no longer reports is dropped, even while nothing may be opened.
        XCTAssertEqual(go(["b"], ["a", "b"]).keep, ["b"])
        XCTAssertEqual(go([], ["a"], here: false, held: true).keep, [])
        XCTAssertEqual(go([]).act, [])
    }

    func testTheNoticeLine() {
        XCTAssertEqual(Door.bringLine(peer: "RappterOne", says: "Enter your password to allow this.", opened: true),
                       "RappterOne needs a press only you can make: Enter your password to allow this. I have opened its screen for you.")
        XCTAssertEqual(Door.bringLine(peer: "RappterOne", says: "  Allow access?  ", opened: true),
                       "RappterOne needs a press only you can make: Allow access. I have opened its screen for you.")
        XCTAssertEqual(Door.bringLine(peer: "RappterOne", says: "", opened: true),
                       "RappterOne needs a press only you can make: a box with no words I could read. I have opened its screen for you.")
        XCTAssertEqual(Door.bringLine(peer: "RappterOne", says: "Allow access", opened: false),
                       "RappterOne needs a press only you can make: Allow access. I could not open its screen, so please go to it.")
    }

    func testTheScreenLinkAndBeingHere() {
        XCTAssertEqual(Door.screenLink("100.77.124.111")?.absoluteString, "vnc://100.77.124.111")
        XCTAssertEqual(Door.screenLink("rappterone.local")?.absoluteString, "vnc://rappterone.local")
        XCTAssertEqual(Door.screenLink("fd7a:115c::1")?.absoluteString, "vnc://[fd7a:115c::1]")
        for bad in ["", " ", "a b", "host/path", "user@host", "host?x=1", "-flag", "h\u{00e9}", String(repeating: "a", count: 101)] {
            XCTAssertNil(Door.screenLink(bad), bad)
        }
        XCTAssertFalse(Door.openScreenFor("not an address/"), "a bad address opens nothing")
        XCTAssertTrue(Door.here(idle: 0)); XCTAssertTrue(Door.here(idle: 59))
        XCTAssertFalse(Door.here(idle: 60)); XCTAssertFalse(Door.here(idle: 4000)); XCTAssertFalse(Door.here(idle: -1))
    }

    func testAPeersNeedOpensItsScreenOnceAndSaysSo() {
        let door = tempDoor()
        var opened: [String] = [], said: [String] = []
        door.openScreen = { opened.append($0); return true }
        door.onAct = { said.append($0) }
        let need: [[String: Any]] = [["id": "securityagent-5", "says": "Enter your password to allow this."]]
        let lines = door.bring(name: "RappterOne", at: "100.77.124.111", needs: need, now: t0)
        XCTAssertEqual(opened, ["100.77.124.111"], "the address that answered")
        XCTAssertEqual(lines, ["RappterOne needs a press only you can make: Enter your password to allow this. I have opened its screen for you."])
        XCTAssertEqual(said, lines)
        XCTAssertTrue(log(door).contains(lines[0]))
        XCTAssertTrue(log(door).contains("\"id\":\"notice-"), "it shows under what I noticed")
        // The same box again, minutes later: nothing.
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.77.124.111", needs: need, now: t0.addingTimeInterval(300)), [])
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(log(door).components(separatedBy: "needs a press only you can make").count - 1, 1)
        // It goes away and is forgotten; the same name coming back later is a new box.
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.77.124.111", needs: [] as [[String: Any]], now: t0.addingTimeInterval(360)), [])
        XCTAssertEqual(door.bring(name: "RappterOne", at: "192.168.1.9", needs: need, now: t0.addingTimeInterval(420)).count, 1)
        XCTAssertEqual(opened, ["100.77.124.111", "192.168.1.9"])
    }

    func testNothingOpensWhileTheOwnerIsAwayOrHandsAreOff() {
        let door = tempDoor()
        var opened = 0, here = false
        door.ownerHere = { here }
        door.openScreen = { _ in opened += 1; return true }
        let need: [[String: Any]] = [["id": "x-1", "says": "Allow?"]]
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: need, now: t0), [])
        XCTAssertEqual(opened, 0); XCTAssertEqual(log(door), "")
        // They sit down: now it opens.
        here = true
        door.hold()
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: need, now: t0.addingTimeInterval(60)), [], "hands off")
        XCTAssertEqual(opened, 0)
        door.release()
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: need, now: t0.addingTimeInterval(120)).count, 1)
        XCTAssertEqual(opened, 1)
    }

    func testOneScreenAMinuteAcrossMacsAndNoAskingWhenNothingIsNeeded() {
        let door = tempDoor()
        var opened: [String] = [], asked = 0
        door.ownerHere = { asked += 1; return true }
        door.openScreen = { opened.append($0); return true }
        // No needs, an old peer with no needs at all, or rubbish: the keys are not even looked at.
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: nil, now: t0), [])
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: "soon", now: t0), [])
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: [["says": "no id"], ["id": 4], ["id": ""]], now: t0), [])
        XCTAssertEqual(asked, 0); XCTAssertEqual(opened, [])
        let one: [[String: Any]] = [["id": "a-1", "says": "One?"], ["id": "a-2"]], two: [[String: Any]] = [["id": "b-1", "says": "Two?"]]
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: one, now: t0).count, 2, "two boxes, one screen, a line for each")
        XCTAssertEqual(door.bring(name: "RappterTwo", at: "100.2.2.2", needs: two, now: t0.addingTimeInterval(15)), [], "too soon after the last screen")
        XCTAssertEqual(opened, ["100.1.1.1"])
        XCTAssertEqual(door.bring(name: "RappterTwo", at: "100.2.2.2", needs: two, now: t0.addingTimeInterval(75)).count, 1)
        XCTAssertEqual(opened, ["100.1.1.1", "100.2.2.2"])
        XCTAssertTrue(log(door).contains("a box with no words I could read"))
    }

    func testAScreenThatWillNotOpenIsSaidOnceNotEveryMinute() {
        let door = tempDoor()
        var tries = 0
        door.openScreen = { _ in tries += 1; return false }
        let need: [[String: Any]] = [["id": "x-1", "says": "Allow?"]]
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: need, now: t0),
                       ["RappterOne needs a press only you can make: Allow. I could not open its screen, so please go to it."])
        XCTAssertEqual(door.bring(name: "RappterOne", at: "100.1.1.1", needs: need, now: t0.addingTimeInterval(120)), [])
        XCTAssertEqual(tries, 1)
    }

    func testThePageSaysAGuardBoxIsYoursToPress() async throws {
        let door = tempDoor()
        door.boxPatience = 60
        let boxes = [(app: "SecurityAgent", words: ["StaticText: Enter your password to allow this.", "Button: Cancel", "Button: OK"]),
                     (app: "NoSuchAppForTests", words: ["StaticText: Save the changes?", "Button: Save"])]
        door.noticeBoxes(boxes, now: Date().addingTimeInterval(-100)); door.noticeBoxes(boxes, now: Date())
        try drop(DoorAsk(id: "p1", do: "page"), in: door)
        await door.drain()
        var page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertEqual(page.components(separatedBy: "This one is yours to press.").count - 1, 1, "only the box that guards the Mac")
        XCTAssertTrue(page.contains("I never press the boxes that guard this Mac.</span>"), "no other Mac, no promise of one")
        XCTAssertTrue(page.contains(">Press Save</a>"))
        // With another Mac known, it says that Mac will bring the screen up.
        try Data("[{\"name\": \"RappterOne\", \"at\": \"100.77.124.111\"}]".utf8).write(to: door.dir.appendingPathComponent("peers.json"))
        try drop(DoorAsk(id: "p2", do: "page"), in: door)
        await door.drain()
        page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertTrue(page.contains("This one is yours to press. I never press the boxes that guard this Mac. Your other Mac will bring this screen up for you."))
        XCTAssertEqual(Door.yours("<li><div>", app: "NoSuchAppForTests", otherMacs: true), "<li><div>")
        XCTAssertTrue(Door.yours("<li>", app: "NetAuthAgent", otherMacs: false).hasPrefix("<li><br>"))
    }
}
