import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorSetupTests: XCTestCase {
    func tempDoor() -> Door {
        Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
    }
    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }
    func answer(_ id: String, in door: Door) throws -> DoorAnswer {
        try JSONDecoder().decode(DoorAnswer.self, from: Data(contentsOf: door.dir.appendingPathComponent("\(id).answer.json")))
    }
    func read(_ name: String, in door: Door) -> String {
        (try? String(contentsOf: door.dir.appendingPathComponent(name), encoding: .utf8)) ?? ""
    }
    let all = DoorSetupFacts(pressing: true, seeing: true, starting: true, hasOtherMacs: true, reaching: true, reached: true, understanding: true, hearing: true)

    func testEverythingAllowedIsSevenPlainLinesAndNoWarning() {
        let items = Door.setupItems(all)
        XCTAssertEqual(items.map(\.name), ["pressing buttons", "seeing the screen", "starting when this Mac starts", "reaching your other Macs",
                                           "being reached by your other Macs", "understanding what you say", "hearing you"])
        XCTAssertEqual(items.map(Door.setupLine).first, "Allowed: pressing buttons.")
        XCTAssertTrue(items.map(Door.setupLine).allSatisfy { $0.hasPrefix("Allowed: ") && !$0.contains("Without") })
        XCTAssertEqual(Door.setupCount(items), "7 of 7 allowed")
        XCTAssertNil(Door.setupNote(items))
    }

    func testSomeMissingSaysWhichAndWhyAndCountsThem() {
        var f = all; f.seeing = false; f.pressing = false
        let items = Door.setupItems(f)
        XCTAssertEqual(Door.setupLine(items[0]), "Not yet: pressing buttons. Without it I cannot press buttons, so jobs and standing answers do not work.")
        XCTAssertTrue(Door.setupLine(items[1]).hasPrefix("Not yet: seeing the screen. Without it "))
        XCTAssertEqual(Door.setupCount(items), "5 of 7 allowed")
        XCTAssertEqual(Door.setupNote(items), "2 things are not allowed yet, so some of what I do will not work.")
        f.pressing = true
        XCTAssertEqual(Door.setupNote(Door.setupItems(f)), "1 thing is not allowed yet, so some of what I do will not work.")
    }

    func testAThingNotKnownYetIsSaidSoAndIsNotCountedEitherWay() {
        var f = all; f.hearing = nil; f.reached = nil
        let items = Door.setupItems(f)
        XCTAssertEqual(Door.setupLine(items[6]), "Not known yet: hearing you. Without it I cannot hear you at all.")
        XCTAssertEqual(Door.setupCount(items), "5 of 7 allowed")
        XCTAssertNil(Door.setupNote(items))
        // Nothing known at all: every line says so, nothing is called allowed, nothing is called turned off.
        let blank = Door.setupItems(DoorSetupFacts())
        XCTAssertEqual(blank.count, 5)
        XCTAssertTrue(blank.map(Door.setupLine).allSatisfy { $0.hasPrefix("Not known yet: ") })
        XCTAssertEqual(Door.setupCount(blank), "0 of 5 allowed")
        XCTAssertNil(Door.setupNote(blank))
    }

    func testWithNoOtherMacsTheirTwoLinesAreLeftOut() {
        var f = all; f.hasOtherMacs = false; f.reaching = false; f.reached = false
        let items = Door.setupItems(f)
        XCTAssertEqual(items.count, 5)
        XCTAssertFalse(items.contains { $0.name.contains("other Macs") })
        XCTAssertEqual(Door.setupCount(items), "5 of 5 allowed")
    }

    func testEveryItemHasPlainWordsAndASettingsPage() {
        for i in Door.setupItems(all) {
            XCTAssertTrue(i.why.hasPrefix("Without it ") && i.why.hasSuffix("."), i.why)
            XCTAssertTrue(i.page.hasPrefix("x-apple.systempreferences:"), i.page)
            XCTAssertNotNil(URL(string: i.page))
            for word in ["Accessibility", "TCC", "plist", "permission", "API", "/", "~"] {
                XCTAssertFalse((i.name + i.why).contains(word), "\(i.name) uses \(word)")
            }
        }
        XCTAssertEqual(Set(Door.setupItems(all).map(\.page)).count, 7)
    }

    func testASettingIsOnlyFoundByANameOnTheList() {
        XCTAssertEqual(Door.settingsPage(for: "pressing buttons")?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        XCTAssertEqual(Door.settingsPage(for: " Seeing the screen ")?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        XCTAssertEqual(Door.settingsPage(for: "hearing you")?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        XCTAssertNotNil(Door.settingsPage(for: "reaching your other Macs"))
        XCTAssertNil(Door.settingsPage(for: "the password"))
        XCTAssertNil(Door.settingsPage(for: "x-apple.systempreferences:com.apple.preference.security"))
        XCTAssertNil(Door.settingsPage(for: "https://example.com"))
        XCTAssertNil(Door.settingsPage(for: ""))
        XCTAssertNil(Door.settingsPage(for: nil))
    }

    func testReachingOtherMacsIsYesNoOrNotKnown() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertNil(Door.reaching(peers: [], seen: ["mini": ["seen": 999_990.0]], now: now))
        XCTAssertNil(Door.reaching(peers: ["mini"], seen: [:], now: now))
        XCTAssertNil(Door.reaching(peers: ["mini"], seen: ["someone else": ["seen": 999_990.0]], now: now))
        XCTAssertEqual(Door.reaching(peers: ["mini"], seen: ["mini": [:]], now: now), false)
        XCTAssertEqual(Door.reaching(peers: ["mini"], seen: ["mini": ["seen": 999_000.0]], now: now), false)
        XCTAssertEqual(Door.reaching(peers: ["mini", "studio"], seen: ["mini": ["seen": 999_000.0], "studio": ["seen": 999_800.0]], now: now), true)
        XCTAssertEqual(Door.reaching(peers: ["mini"], seen: ["mini": ["seen": 999_700.0]], now: now), true)
    }

    func testTheOtherMacsAreReadFromTheDoorsOwnFolder() throws {
        let door = tempDoor()
        let now = Date(timeIntervalSince1970: 2_000_000)
        var f = door.otherMacs(into: DoorSetupFacts(), now: now)
        XCTAssertFalse(f.hasOtherMacs); XCTAssertNil(f.reaching); XCTAssertNil(f.reached)
        // A report with no other Macs named changes nothing.
        door.noteReport(now: now)
        XCTAssertNil(door.otherMacs(into: DoorSetupFacts(), now: now).reached)
        try FileManager.default.removeItem(at: door.reportedURL)
        try Data("[{\"name\":\"NoSuchMacForTests\",\"at\":\"100.70.1.1\"}]".utf8).write(to: door.dir.appendingPathComponent("peers.json"))
        f = door.otherMacs(into: DoorSetupFacts(), now: now)
        XCTAssertTrue(f.hasOtherMacs); XCTAssertNil(f.reaching); XCTAssertNil(f.reached)
        XCTAssertNil(door.lastReport())
        // Tried and nothing came back.
        _ = door.peerBeat(name: "NoSuchMacForTests", heard: nil, now: now)
        XCTAssertEqual(door.otherMacs(into: DoorSetupFacts(), now: now).reaching, false)
        // It answered, then five minutes pass with nothing.
        _ = door.peerBeat(name: "NoSuchMacForTests", heard: [], now: now)
        XCTAssertEqual(door.otherMacs(into: DoorSetupFacts(), now: now).reaching, true)
        XCTAssertEqual(door.otherMacs(into: DoorSetupFacts(), now: now.addingTimeInterval(301)).reaching, false)
        // The other Mac got through to this one.
        door.noteReport(now: now)
        XCTAssertEqual(door.lastReport(), now)
        XCTAssertEqual(door.otherMacs(into: DoorSetupFacts(), now: now).reached, true)
        // A broken note is the same as none.
        try Data("not a note".utf8).write(to: door.reportedURL)
        XCTAssertNil(door.otherMacs(into: DoorSetupFacts(), now: now).reached)
    }

    func testTheSetupAskSaysEachLineAndTheCount() async throws {
        let door = tempDoor()
        var f = all; f.seeing = false; f.hearing = nil
        door.setupFacts = { f }
        var opened: [URL] = []
        door.openSetting = { opened.append($0); return true }
        try drop(DoorAsk(id: "s1", do: "setup"), in: door)
        await door.drain()
        let got = try answer("s1", in: door)
        XCTAssertTrue(got.ok)
        XCTAssertEqual(got.said, "5 of 7 allowed")
        XCTAssertEqual(got.words?.count, 7)
        XCTAssertEqual(got.words?[0], "Allowed: pressing buttons.")
        XCTAssertEqual(got.words?[1], "Not yet: seeing the screen. Without it I cannot take a picture of the screen, so I cannot show you what changed.")
        XCTAssertEqual(got.words?[6], "Not known yet: hearing you. Without it I cannot hear you at all.")
        XCTAssertEqual(Door.line(DoorAsk(id: "", do: "setup")), "checking what I am allowed to do")
        XCTAssertTrue(opened.isEmpty, "asking what is allowed never opens anything")
        XCTAssertTrue(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("setup.html").path))
    }

    func testTheSetupPageShowsEachItemAndAButtonOnlyForWhatIsTurnedOff() throws {
        let door = tempDoor()
        var f = all; f.pressing = false; f.seeing = false; f.hearing = nil
        door.setupFacts = { f }
        XCTAssertTrue(door.writePage(hours: 24).ok)
        let page = read("setup.html", in: door)
        XCTAssertTrue(page.contains("<title>Getting set up</title>") && page.contains("<h1>Getting set up</h1>"))
        XCTAssertTrue(page.contains("These are yours to allow. I only open the right page."))
        XCTAssertTrue(page.contains("5 of 7 allowed") == false && page.contains("4 of 7 allowed"))
        XCTAssertEqual(page.components(separatedBy: "\u{2713}").count - 1, 4)
        XCTAssertEqual(page.components(separatedBy: "\u{2717}").count - 1, 2)
        XCTAssertEqual(page.components(separatedBy: "<i>?</i>").count - 1, 1)
        XCTAssertEqual(page.components(separatedBy: ">Open the setting</a>").count - 1, 2)
        XCTAssertTrue(page.contains("Without it I cannot press buttons, so jobs and standing answers do not work."))
        XCTAssertFalse(page.contains("x-apple") || page.contains("Privacy_"), "the page never shows the machinery")
        // The buttons are offers of this page-load, and each is an ask that only opens a setting.
        let offers = try JSONDecoder().decode([String: [DoorAsk]].self, from: Data(contentsOf: door.dir.appendingPathComponent("offers.json")))
        let token = offers["token"]![0].id
        XCTAssertEqual(offers["offers"]!.map(\.do), ["settings", "settings"])
        XCTAssertEqual(offers["offers"]!.compactMap(\.title), ["pressing buttons", "seeing the screen"])
        for o in offers["offers"]! { XCTAssertTrue(page.contains("href=\"openrappter://pick/\(token)/\(o.id)\">Open the setting</a>")) }
        // On the web the same buttons become forms that post, like every other button.
        let web = DoorWeb.forWeb(page)
        XCTAssertFalse(web.contains("openrappter://"))
        XCTAssertEqual(web.components(separatedBy: "<form method=\"post\" action=\"/pick\">").count - 1, 2)
    }

    func testTheMainPageSaysSoAtTheTopOnlyWhileSomethingIsTurnedOff() throws {
        let door = tempDoor()
        var f = all; f.pressing = false; f.seeing = false
        door.setupFacts = { f }
        _ = door.writePage(hours: 24)
        var page = read("page.html", in: door)
        XCTAssertTrue(page.contains("<a href=\"setup.html\" style=\"color:#f0a04b\">2 things are not allowed yet, so some of what I do will not work.</a>"))
        XCTAssertLessThan(page.range(of: "not allowed yet")!.lowerBound, page.range(of: "Left for you")!.lowerBound)
        XCTAssertTrue(page.contains("Nothing. You do not need to do anything."), "setup is not a thing left for you")
        f = all; f.hearing = nil
        _ = door.writePage(hours: 24)
        page = read("page.html", in: door)
        XCTAssertFalse(page.contains("not allowed yet") || page.contains("setup.html"))
        let setup = read("setup.html", in: door)
        XCTAssertFalse(setup.contains("Open the setting"))
        XCTAssertTrue(setup.contains("6 of 7 allowed"))
    }

    func testTheSetupButtonsSitBesideTheOtherButtonsWithoutDisturbingThem() throws {
        let door = tempDoor()
        var f = all; f.seeing = false
        door.setupFacts = { f }
        door.hold()
        _ = door.writePage(hours: 24)
        let offers = try JSONDecoder().decode([String: [DoorAsk]].self, from: Data(contentsOf: door.dir.appendingPathComponent("offers.json")))
        XCTAssertEqual(offers["offers"]!.map(\.do), ["resume", "settings"])
        XCTAssertEqual(offers["offers"]!.map(\.id), ["o1", "o2"])
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        XCTAssertEqual((left["left"] as? [[String: Any]])?.count, 1)
    }

    func testPressingTheButtonOpensTheRightPageOnceAndNothingElse() async throws {
        let door = tempDoor()
        var f = all; f.seeing = false
        door.setupFacts = { f }
        var opened: [URL] = []
        door.openSetting = { opened.append($0); return true }
        _ = door.writePage(hours: 24)
        let offers = try JSONDecoder().decode([String: [DoorAsk]].self, from: Data(contentsOf: door.dir.appendingPathComponent("offers.json")))
        let token = offers["token"]![0].id
        XCTAssertFalse(door.take(token: "wrong", key: "o1"))
        XCTAssertTrue(door.take(token: token, key: "o1"))
        XCTAssertFalse(door.take(token: token, key: "o1"), "the same click cannot land twice")
        await door.drain()
        XCTAssertEqual(opened.map(\.absoluteString), ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"])
        let log = read("log.jsonl", in: door)
        XCTAssertTrue(log.contains("opening the setting for seeing the screen"))
        XCTAssertTrue(log.contains("opened the setting for seeing the screen. Allowing it is yours to do"))
    }

    func testTheSettingsAskRefusesAnythingNotOnTheList() async throws {
        let door = tempDoor()
        door.setupFacts = { self.all }
        var opened: [URL] = []
        door.openSetting = { opened.append($0); return true }
        var bad = DoorAsk(id: "g1", do: "settings"); bad.title = "NoSuchSettingForTests"
        var link = DoorAsk(id: "g2", do: "settings"); link.title = "seeing the screen"; link.text = "https://example.com"
        var smuggled = DoorAsk(id: "g3", do: "settings"); smuggled.text = "x-apple.systempreferences:com.apple.preference.security"
        try drop(bad, in: door); try drop(DoorAsk(id: "g0", do: "settings"), in: door); try drop(smuggled, in: door)
        await door.drain()
        for id in ["g0", "g1", "g3"] {
            XCTAssertFalse(try answer(id, in: door).ok)
            XCTAssertEqual(try answer(id, in: door).said, "I do not know that setting, so I opened nothing")
        }
        XCTAssertTrue(opened.isEmpty)
        // Only the name picks the page; nothing else in the ask can point it somewhere else.
        try drop(link, in: door)
        await door.drain()
        XCTAssertTrue(try answer("g2", in: door).ok)
        XCTAssertEqual(opened.map(\.absoluteString), ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"])
    }

    func testTheSettingsAskSaysSoWhenThePageWouldNotOpenAndWaitsWhileHandsAreOff() async throws {
        let door = tempDoor()
        door.setupFacts = { self.all }
        var tried = 0
        door.openSetting = { _ in tried += 1; return false }
        var a = DoorAsk(id: "f1", do: "settings"); a.title = "hearing you"
        try drop(a, in: door)
        await door.drain()
        XCTAssertFalse(try answer("f1", in: door).ok)
        XCTAssertEqual(try answer("f1", in: door).said, "could not open the setting for hearing you")
        XCTAssertEqual(tried, 1)
        door.hold()
        var b = DoorAsk(id: "f2", do: "settings"); b.title = "hearing you"
        try drop(b, in: door)
        await door.drain()
        XCTAssertFalse(try answer("f2", in: door).ok)
        XCTAssertTrue(try answer("f2", in: door).said.hasPrefix("hands off is on"))
        XCTAssertEqual(tried, 1)
    }
}
