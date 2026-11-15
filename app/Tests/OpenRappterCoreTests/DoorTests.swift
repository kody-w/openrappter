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

    func testThePageOverThePrivateNetworkOnlyTakesAPostFromAnAllowedPlace() {
        XCTAssertTrue(DoorWeb.allowed("100.77.124.111")); XCTAssertTrue(DoorWeb.allowed("127.0.0.1")); XCTAssertTrue(DoorWeb.allowed("::ffff:100.64.0.9"))
        XCTAssertFalse(DoorWeb.allowed("192.168.86.191")); XCTAssertFalse(DoorWeb.allowed("100.128.0.1")); XCTAssertFalse(DoorWeb.allowed("8.8.8.8"))
        let web = DoorWeb.forWeb("<style>a{}</style><a class=\"btn quiet\" href=\"openrappter://pick/TOK/o2\">Press Later</a>")
        XCTAssertTrue(web.contains("<form method=\"post\" action=\"/pick\">") && web.contains("value=\"TOK\"") && web.contains(">Press Later</button>"))
        XCTAssertFalse(web.contains("openrappter://"))
        let raw = Data("POST /pick HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 10\r\n\r\nt=TOK&k=o2".utf8)
        let r = DoorWeb.parse(raw)!
        XCTAssertEqual(DoorWeb.choice(r)?.token, "TOK"); XCTAssertEqual(DoorWeb.choice(r)?.offer, "o2")
        XCTAssertNil(DoorWeb.parse(Data("POST /pick HTTP/1.1\r\nContent-Length: 10\r\n\r\nt=TO".utf8)))
    }

    func testAQuestionShowsWithAButtonPerChoiceAndThePickComesBack() async throws {
        let door = tempDoor()
        var q = DoorAsk(id: "q-1", do: "question"); q.title = "Restart tonight?"; q.choices = ["Yes", "Not now"]
        try drop(q, in: door)
        try drop(DoorAsk(id: "p9", do: "page"), in: door)
        await door.drain()
        XCTAssertNil(door.answered("q-1"))
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json"))) as! [String: Any]
        XCTAssertEqual(left["schema"] as? String, "openrappter-door/1")
        let row = (left["left"] as! [[String: Any]])[0]
        XCTAssertEqual(row["says"] as? String, "Restart tonight?")
        let choices = row["choices"] as! [[String: String]]
        XCTAssertEqual(choices.map { $0["label"] }, ["Yes", "Not now"])
        let ok = await door.pick(token: left["token"] as! String, key: choices[1]["offer"]!)
        XCTAssertTrue(ok)
        XCTAssertEqual(door.answered("q-1")?["picked"] as? String, "Not now")
        let again = await door.pick(token: left["token"] as! String, key: choices[0]["offer"]!)
        XCTAssertFalse(again)
    }

    func testPageNeverSwallowsItself() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)")
        let door = Door(dir: dir)
        let now = Date().timeIntervalSince1970
        let line = "{\"at\":\(now),\"did\":\"writing the page\",\"id\":\"a1\",\"ok\":true,\"picture\":\"page.html\",\"said\":\"page ready\"}\n"
        try Data(line.utf8).write(to: dir.appendingPathComponent("log.jsonl"))
        var sizes: [Int] = []
        for _ in 0..<4 {
            _ = door.writePage(hours: 24)
            sizes.append((try Data(contentsOf: dir.appendingPathComponent("page.html"))).count)
        }
        XCTAssertLessThan(sizes[3], sizes[0] + 2000, "the page grew on refresh: \(sizes)")
        XCTAssertNil(Door.small(Data("not a picture".utf8)))
    }

    func testAnAnswerMadeToStickIsPressedNextTimeAndCanBeStopped() async throws {
        let door = tempDoor()
        door.boxPatience = 60
        let t0 = Date()
        let words = ["StaticText: Reopen windows?", "Button: Reopen", "Button: Cancel"]
        let box = [(app: "NoSuchAppForTests", words: words)]
        door.noticeBoxes(box, now: t0); door.noticeBoxes(box, now: t0.addingTimeInterval(61))
        _ = door.writePage(hours: 24)
        var page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertTrue(page.contains(">Always Cancel</a>"))
        // Make it stick.
        var a = DoorAsk(id: "s1", do: "always"); a.app = "NoSuchAppForTests"; a.title = "Cancel"; a.text = Door.boxSays(words)
        a.steps = Door.boxButtons(words).map { var s = DoorAsk(id: "", do: "press"); s.title = $0; return s }
        try drop(a, in: door); await door.drain()
        XCTAssertEqual(door.alwaysRules().map(\.press), ["Cancel"])
        func presses() -> Int { ((try? FileManager.default.contentsOfDirectory(atPath: door.dir.path)) ?? []).filter { $0.hasPrefix("always-") }.count }
        // The box goes away and comes back later: pressed on its own after a beat, never at first sight.
        door.noticeBoxes([], now: t0.addingTimeInterval(100))
        let before = presses()
        door.noticeBoxes(box, now: t0.addingTimeInterval(200))
        XCTAssertEqual(presses(), before)
        door.noticeBoxes(box, now: t0.addingTimeInterval(215))
        XCTAssertEqual(presses(), before + 1)
        XCTAssertTrue(try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8).contains("I pressed Cancel, as you always do"))
        // A different question from the same app is left alone.
        door.noticeBoxes([(app: "NoSuchAppForTests", words: ["StaticText: Delete all mail?", "Button: Reopen", "Button: Cancel"])], now: t0.addingTimeInterval(300))
        door.noticeBoxes([(app: "NoSuchAppForTests", words: ["StaticText: Delete all mail?", "Button: Reopen", "Button: Cancel"])], now: t0.addingTimeInterval(315))
        XCTAssertEqual(presses(), before + 1)
        // A box that keeps coming back is pressed three times in ten minutes, then handed to the owner.
        for i in 0..<12 { door.noticeBoxes(box, now: t0.addingTimeInterval(400 + Double(i) * 15)) }
        XCTAssertEqual(presses(), before + 3)
        // Hands off: nothing is pressed.
        door.noticeBoxes([], now: t0.addingTimeInterval(2000)); door.hold()
        door.noticeBoxes(box, now: t0.addingTimeInterval(2100)); door.noticeBoxes(box, now: t0.addingTimeInterval(2115))
        XCTAssertEqual(presses(), before + 3)
        door.release()
        // Boxes that guard the Mac never stick.
        var g = DoorAsk(id: "s2", do: "always"); g.app = "SecurityAgent"; g.title = "Allow"; g.text = "x"
        try drop(g, in: door); await door.drain()
        XCTAssertEqual(door.alwaysRules().count, 1)
        // The page lists it with a way out, and stopping it works.
        _ = door.writePage(hours: 24)
        page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        XCTAssertTrue(page.contains("Answers you made stick") && page.contains(">Ask me again instead</a>"))
        var off = a; off.id = "s3"; off.key = "off"
        try drop(off, in: door); await door.drain()
        XCTAssertEqual(door.alwaysRules().count, 0)
    }

    func testOnePageForAllMacs() throws {
        let one: [String: Any] = ["mac": "One", "token": "T1", "left": [["says": "Mail is asking: Reopen?", "choices": [["offer": "o1", "label": "Press Reopen"], ["offer": "o2", "label": "Always Reopen"]]]]]
        let page = DoorWeb.allPage([(name: "Two", base: "", doc: ["mac": "Two", "token": "T2", "left": [[String: Any]]()]),
                                    (name: "One", base: "http://100.77.124.111:7466", doc: one),
                                    (name: "Gone <b>", base: "http://100.70.1.1:7466", doc: nil)], back: "http://100.70.213.17:7466/all")
        XCTAssertTrue(page.contains("1 waiting on you."))
        XCTAssertTrue(page.contains("action=\"http://100.77.124.111:7466/pick\"") && page.contains("value=\"T1\"") && page.contains(">Press Reopen</button>"))
        XCTAssertTrue(page.contains("name=\"back\" value=\"http://100.70.213.17:7466/all\""))
        XCTAssertTrue(page.contains("Gone &lt;b>") && page.contains("data-base=\"http://100.70.1.1:7466\"") && page.contains("fetch(base + \"/left.json\")"))
        XCTAssertFalse(page.contains("href=\"openrappter://"))
        // Coming back is only ever to another door page on the private network.
        XCTAssertTrue(DoorWeb.safeBack("http://100.70.213.17:7466/all")); XCTAssertTrue(DoorWeb.safeBack("http://rapptertwo.tail99115f.ts.net:7466/all"))
        XCTAssertFalse(DoorWeb.safeBack("http://evil.example/all")); XCTAssertFalse(DoorWeb.safeBack("https://100.70.213.17/all?x=1"))
        XCTAssertFalse(DoorWeb.safeBack("http://100.70.213.17:7466/pick")); XCTAssertFalse(DoorWeb.safeBack("javascript:alert(1)"))
        let raw = Data("POST /pick HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 53\r\n\r\nt=T&k=o1&back=http%3A%2F%2F100.70.213.17%3A7466%2Fall".utf8)
        XCTAssertEqual(DoorWeb.form(DoorWeb.parse(raw)!)["back"], "http://100.70.213.17:7466/all")
    }

    func testWhyABoxCameUp() {
        let t = Date(timeIntervalSince1970: 1_000_000), longAgo = t.addingTimeInterval(-90_000)
        XCTAssertEqual(Door.cause(since: t, bootedAt: longAgo, appOpened: longAgo, app: "Mail", last: (t.addingTimeInterval(-5), "doing the job tidy up")), "right after I was doing the job tidy up")
        XCTAssertEqual(Door.cause(since: t, bootedAt: longAgo, appOpened: t.addingTimeInterval(-10), app: "Mail", last: nil), "when Mail opened")
        XCTAssertEqual(Door.cause(since: t, bootedAt: t.addingTimeInterval(-120), appOpened: t.addingTimeInterval(-10), app: "Mail", last: nil), "when Mail opened after this Mac restarted")
        XCTAssertEqual(Door.cause(since: t, bootedAt: t.addingTimeInterval(-120), appOpened: nil, app: "Mail", last: nil), "right after this Mac restarted")
        XCTAssertNil(Door.cause(since: t, bootedAt: longAgo, appOpened: longAgo, app: "Mail", last: (t.addingTimeInterval(-600), "pressing OK")))
    }

    func testBeforeAndAfterIsKeptForWhatTheDoorDoes() async throws {
        let door = tempDoor()
        var shots = 0
        door.snap = { url in shots += 1; return (try? Data("picture \(shots)".utf8).write(to: url)) != nil }
        func answer(_ id: String, ok: Bool) -> DoorAnswer { DoorAnswer(id: id, ok: ok, said: ok ? "pressed OK" : "no such button", front: nil, words: nil, picture: nil, at: Date().timeIntervalSince1970) }
        var press = DoorAsk(id: "p/../1", do: "press"); press.title = "OK"
        // Something done: two pictures and a page, under a plain name.
        let (a1, proof) = await door.withProof(press) { answer("p1", ok: true) }
        XCTAssertTrue(a1.ok); XCTAssertEqual(proof, "p----1")
        let dir = door.dir.appendingPathComponent("proof")
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("p----1-before.jpg"), encoding: .utf8), "picture 1")
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("p----1-after.jpg"), encoding: .utf8), "picture 2")
        XCTAssertTrue(try String(contentsOf: dir.appendingPathComponent("p----1.html"), encoding: .utf8).contains("pressed OK"))
        // Something that did not happen leaves nothing behind; looking takes no pictures; hands off takes none.
        press.id = "p2"
        let (_, none) = await door.withProof(press) { answer("p2", ok: false) }
        XCTAssertNil(none); XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("p2-before.jpg").path))
        let before = shots
        _ = await door.withProof(DoorAsk(id: "l1", do: "look")) { answer("l1", ok: true) }
        door.hold(); press.id = "p3"; _ = await door.withProof(press) { answer("p3", ok: true) }; door.release()
        XCTAssertEqual(shots, before)
        // Only the newest are kept.
        for i in 0..<5 { press.id = "k\(i)"; _ = await door.withProof(press, keep: 3) { answer("k", ok: true) }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".html") }.count, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("p----1-before.jpg").path))
        // The page links to it, and only plain names can be fetched.
        door.record(press, answer("k4", ok: true), proof: "k4")
        _ = door.writePage(hours: 24)
        XCTAssertTrue(try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8).contains("href=\"proof/k4.html\">before and after</a>"))
        XCTAssertEqual(DoorWeb.proofKind("k4.html"), "text/html; charset=utf-8"); XCTAssertEqual(DoorWeb.proofKind("k4-after.jpg"), "image/jpeg")
        XCTAssertNil(DoorWeb.proofKind("../log.jsonl")); XCTAssertNil(DoorWeb.proofKind("k4.png")); XCTAssertNil(DoorWeb.proofKind("a.b.html")); XCTAssertNil(DoorWeb.proofKind(".html"))
    }

    func testARestartKeepsYourPlaceAndSaysWhatChanged() async throws {
        let door = tempDoor()
        let fm = FileManager.default
        let mail = door.dir.appendingPathComponent("Mail.app").path, notes = door.dir.appendingPathComponent("Notes.app").path
        try fm.createDirectory(atPath: mail, withIntermediateDirectories: true); try fm.createDirectory(atPath: notes, withIntermediateDirectories: true)
        let boot1 = Date(timeIntervalSince1970: 2_000_000), t = boot1.addingTimeInterval(5000)
        var opened: [String] = []
        let both = [(name: "Mail", path: mail), (name: "Notes", path: notes), (name: "Gone", path: "/nowhere/Gone.app")]
        door.keepPlace(now: t, bootedAt: boot1, running: both, os: "27.0.1") { opened.append($0); return true }
        XCTAssertEqual(try JSONDecoder().decode(DoorPlace.self, from: Data(contentsOf: door.dir.appendingPathComponent("place.json"))).names, ["Mail", "Notes", "Gone"])
        // The Mac restarts and is updated. Mail came back by itself; Notes did not; Gone is no longer installed.
        let boot2 = t.addingTimeInterval(600)
        door.keepPlace(now: boot2.addingTimeInterval(30), bootedAt: boot2, running: [], os: "27.2.1") { opened.append($0); return true }
        XCTAssertEqual(opened, [], "it waits for the Mac to bring its own things back first")
        door.hold(); door.keepPlace(now: boot2.addingTimeInterval(100), bootedAt: boot2, running: [], os: "27.2.1") { opened.append($0); return true }; door.release()
        XCTAssertEqual(opened, [], "hands off")
        door.keepPlace(now: boot2.addingTimeInterval(120), bootedAt: boot2, running: [(name: "Mail", path: mail)], os: "27.2.1") { opened.append($0); return true }
        XCTAssertEqual(opened, [notes])
        let log = try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)
        XCTAssertTrue(log.contains("this Mac restarted. I reopened Notes. I could not reopen Gone. It was updated from 27.0.1 to 27.2.1"))
        // Only once per restart.
        door.keepPlace(now: boot2.addingTimeInterval(200), bootedAt: boot2, running: [(name: "Mail", path: mail)], os: "27.2.1") { opened.append($0); return true }
        XCTAssertEqual(opened, [notes])
        // Waiting updates are named once, and again only when the list changes.
        XCTAssertEqual(Door.updateNames("Software Update Tool\n\n* Label: macOS 27.2.1-26B131\n\tTitle: macOS\n* Label: Command Line Tools for Xcode 27.2-27.2\n"), ["macOS 27.2.1-26B131", "Command Line Tools for Xcode 27.2-27.2"])
        XCTAssertEqual(Door.updateNames("No new software available."), [])
        func waitLog(_ n: Int) async throws -> Int {
            for _ in 0..<40 { try await Task.sleep(for: .milliseconds(50)); let c = ((try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").components(separatedBy: "waiting for this Mac").count - 1; if c >= n { return c } }
            return ((try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").components(separatedBy: "waiting for this Mac").count - 1
        }
        door.checkUpdates(now: t) { "* Label: macOS 27.2.1-26B131\n" }
        let first = try await waitLog(1)
        XCTAssertEqual(first, 1)
        door.checkUpdates(now: t.addingTimeInterval(3600)) { "* Label: other\n" }           // too soon
        door.checkUpdates(now: t.addingTimeInterval(90000)) { "* Label: macOS 27.2.1-26B131\n" } // same list
        try await Task.sleep(for: .milliseconds(300))
        let second = try await waitLog(1)
        XCTAssertEqual(second, 1)
    }

    func testAnAppThatSignedYouOutIsToldOnceBeforeAJobFails() throws {
        XCTAssertEqual(Door.signedOut(["StaticText: Your session has expired", "Button: Sign In"]), "Your session has expired")
        XCTAssertEqual(Door.signedOut(["StaticText: I can't think until you sign me in with GitHub."]), "I can't think until you sign me in with GitHub.")
        XCTAssertNil(Door.signedOut(["StaticText: Inbox", "Button: Sign In to iCloud Photos sharing options"]))
        XCTAssertNil(Door.signedOut(["StaticText: " + String(repeating: "a long article that mentions being signed out somewhere ", count: 5)]))
        let door = tempDoor()
        let t = Date(timeIntervalSince1970: 3_000_000)
        let out = [(app: "Orders", words: ["StaticText: Please sign in to continue", "Button: Sign In"]), (app: "Notes", words: ["StaticText: Shopping"])]
        func told() -> Int { ((try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").components(separatedBy: "wants you to sign in again").count - 1 }
        door.noticeSignOuts(out, now: t)
        XCTAssertEqual(told(), 0, "one look is not enough: it may be a passing screen")
        door.noticeSignOuts(out, now: t.addingTimeInterval(300))
        XCTAssertEqual(told(), 1)
        for i in 2..<10 { door.noticeSignOuts(out, now: t.addingTimeInterval(Double(i) * 300)) }
        XCTAssertEqual(told(), 1, "once a day, not every look")
        door.noticeSignOuts(out, now: t.addingTimeInterval(90000))
        XCTAssertEqual(told(), 2)
        XCTAssertTrue(try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8).contains("Orders wants you to sign in again (it says \\\"Please sign in to continue\\\")"))
    }

    func testAMacThatGoesQuietIsToldAndItsMarkedJobsAreCovered() async throws {
        let door = tempDoor()
        var step = DoorAsk(id: "", do: "look"); step.app = "x"
        var learn = DoorAsk(id: "l1", do: "learn"); learn.title = "nightly tidy"; learn.steps = [step]
        try drop(learn, in: door); await door.drain()
        let t = Date(timeIntervalSince1970: 4_000_000)
        func log() -> String { (try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "" }
        let theirs: [[String: Any]] = [["title": "tidy each hour", "job": "nightly tidy", "every": 60.0, "fired": t.timeIntervalSince1970 - 600],
                                       ["title": "unknown here", "job": "a job this Mac never learned", "every": 5.0, "fired": 0.0]]
        // Never heard from: silence means nothing yet.
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t).count, 0); XCTAssertFalse(log().contains("gone quiet"))
        XCTAssertEqual(door.peerBeat(name: "One", heard: theirs, now: t).count, 0)
        // One missed beat is not quiet; three minutes is, said once.
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(60)).count, 0); XCTAssertFalse(log().contains("gone quiet"))
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(200)).count, 0)
        XCTAssertTrue(log().contains("One has gone quiet: no answer for 3 min. Until it is back I run its jobs: tidy each hour"))
        _ = door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(260))
        XCTAssertEqual(log().components(separatedBy: "gone quiet").count - 1, 1)
        // Its hourly job ran 10 minutes before it went quiet, so it is covered 50 minutes later, once, and only the job this Mac knows.
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(1800)).count, 0)
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(3100)).map(\.job), ["nightly tidy"])
        XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(3200)).count, 0)
        // Hands off: nothing is covered. Back again: said once, covering stops.
        door.hold(); XCTAssertEqual(door.peerBeat(name: "One", heard: nil, now: t.addingTimeInterval(8000)).count, 0); door.release()
        XCTAssertEqual(door.peerBeat(name: "One", heard: theirs, now: t.addingTimeInterval(8100)).count, 0)
        XCTAssertTrue(log().contains("One is back after 135 min of quiet. I have stopped covering for it"))
        // A Mac that reports in is alive, but cannot hand over jobs that way; a stranger's report is ignored.
        try Data("[{\"name\": \"RappterOne\", \"at\": \"100.77.124.111\"}]".utf8).write(to: door.dir.appendingPathComponent("peers.json"))
        XCTAssertFalse(door.reportedIn(mac: "Somebody's PC", now: t.addingTimeInterval(9000)))
        XCTAssertTrue(door.reportedIn(mac: "RappterOne\u{2019}s Mac mini", now: t.addingTimeInterval(9000)))
        XCTAssertEqual(door.peerBeat(name: "RappterOne", heard: nil, now: t.addingTimeInterval(9100)).count, 0)
        _ = door.peerBeat(name: "RappterOne", heard: nil, now: t.addingTimeInterval(9200))
        XCTAssertTrue(log().contains("RappterOne has gone quiet: no answer for 3 min") && !log().contains("RappterOne has gone quiet: no answer for 3 min. Until"))
        // What this Mac says about itself, and who may ask.
        var w = DoorAsk(id: "w1", do: "watch"); w.title = "tidy at night"; w.job = "nightly tidy"; w.at = "02:00"; w.with = ["cover"]
        try drop(w, in: door); await door.drain()
        let beat = door.beat(now: t)
        XCTAssertEqual((beat["cover"] as? [[String: Any]])?.first?["title"] as? String, "tidy at night")
        XCTAssertNil(beat["token"])
        XCTAssertTrue(DoorWeb.homeNet("192.168.86.209")); XCTAssertTrue(DoorWeb.homeNet("10.0.0.5")); XCTAssertTrue(DoorWeb.homeNet("::ffff:172.20.1.1"))
        XCTAssertFalse(DoorWeb.homeNet("8.8.8.8")); XCTAssertFalse(DoorWeb.homeNet("172.32.0.1")); XCTAssertFalse(DoorWeb.homeNet("100.70.213.17"))
    }
}
