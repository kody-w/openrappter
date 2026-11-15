import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorWeekTests: XCTestCase {
    func tempDoor() -> Door {
        Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false)
    }

    func drop(_ ask: DoorAsk, in door: Door) throws {
        try JSONEncoder().encode(ask).write(to: door.dir.appendingPathComponent("\(ask.id).json"))
    }

    var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    func day(_ d: Int, _ h: Int, _ m: Int = 0) -> Date { utc.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))! }

    func line(_ at: Date, _ id: String, _ did: String, _ ok: Bool, _ said: String) -> [String: Any] {
        ["at": at.timeIntervalSince1970, "id": id, "did": did, "ok": ok, "said": said]
    }

    /// A week as the door itself would have written it. Now is Wednesday 18 November 2026, noon.
    func handMadeWeek() -> [[String: Any]] {
        let t = day(16, 9)
        return [
            // Too old, or not yet happened: never counted.
            line(day(10, 9), "notice-1-always1", "noticed a box waiting", true, "Mail asked \"Reopen?\" and I pressed Cancel, as you always do"),
            line(day(11, 11, 59), "watch-1-old", "doing the job tidy", true, "tidy: 9 steps done"),
            line(day(19, 9), "watch-9-later", "doing the job tidy", true, "tidy: 9 steps done"),
            // Standing answers: the note, and the press that went with it.
            line(t, "notice-2-always1", "noticed a box waiting", true, "Mail asked \"Reopen?\" and I pressed Cancel, as you always do"),
            line(t, "always-2-1", "pressing Cancel", true, "pressed Cancel"),
            line(t, "notice-3-always1", "noticed a box waiting", true, "Notes asked \"Keep?\" and I pressed Keep, as you always do"),
            // Chores on a clock or a sight.
            line(t, "watch-4-morning", "doing the job open report", true, "open report: 5 steps done"),
            line(t, "watch-5-morning", "doing the job open report", true, "open report: 3 steps done, 2 not needed"),
            line(t, "watch-6-morning", "doing the job open report", false, "open report stopped at step 2: nothing on screen says Export"),
            // Covering for another Mac.
            line(t, "cover-7-tidy", "doing the job nightly tidy", true, "nightly tidy: 12 steps done"),
            // Asked by hand.
            line(t, "j1", "doing the job wake", true, "wake: 1 steps done"),
            // Noticed.
            line(t, "notice-8", "noticed a box waiting", true, "a box from Installer has been waiting 1 min: StaticText: Allow this?"),
            line(t, "notice-9-place", "noticed a box waiting", true, "this Mac restarted. I reopened Notes"),
            line(t, "notice-10-peer-one", "noticed a box waiting", true, "One has gone quiet: no answer for 3 min"),
            line(t, "notice-11-peer-one", "noticed a box waiting", true, "One is back after 135 min of quiet. I have stopped covering for it"),
            line(t, "notice-12-signin-orders", "noticed a box waiting", true, "Orders wants you to sign in again (it says \"Please sign in\"). Jobs that use it will not work until you do"),
            // Could not do: grouped by plain reason.
            line(t, "watch-13-x", "doing the job a: b", false, "a: b stopped at step 4: nothing on screen says Export"),
            line(t, "p1", "pressing Export", false, "nothing on screen says Export"),
            line(t, "o1", "opening Orders", false, "hands off is on, so I did not do that. Ask resume to let me work again."),
            line(t, "j2", "doing the job wake", false, "wake stopped before step 1: hands off"),
            line(t, "k1", "pressing the q key", false, "quitting needs the app named, so I did not press it"),
            line(t, "j3", "doing the job fly", false, "I have not learned fly"),
            // Not acting, so a no here is not a failure: looking, an unknown ask, a watch that could not be kept.
            line(t, "l1", "looking at the screen", false, "could not see: screen and accessibility both not allowed"),
            line(t, "d1", "asked for something I do not know: dance", false, "I do not know how to dance"),
            line(t, "w0", "keeping watch: morning", false, "watch needs a name and a job I have learned"),
            // A line with no time at all is skipped, not counted as now.
            ["id": "watch-broken", "did": "doing the job tidy", "ok": true, "said": "tidy: 99 steps done"],
        ]
    }

    func testTheWeekIsCountedFromTheRecord() {
        let w = Door.week(lines: handMadeWeek(), now: day(18, 12), calendar: utc)
        XCTAssertEqual(w.answered, 2)
        XCTAssertEqual(w.chores, 2)
        XCTAssertEqual(w.covered, 1)
        XCTAssertEqual(w.asked, 1)
        XCTAssertEqual(w.ran, 4)
        XCTAssertEqual(w.noticed, 1)
        XCTAssertEqual(w.restarts, 1)
        XCTAssertEqual(w.quiet, 1)
        XCTAssertEqual(w.failed, 7)
        XCTAssertEqual(w.reasons, [DoorWeek.Reason(why: "Nothing on screen says Export", times: 3),
                                   DoorWeek.Reason(why: "Hands off was on", times: 2),
                                   DoorWeek.Reason(why: "I have not learned fly", times: 1)])
        XCTAssertEqual(w.presses, 5 + 3 + 12 + 1 + 2, "the steps inside each job that worked, plus one for each standing answer")
        XCTAssertFalse(w.isEmpty)
    }

    func testOldLinesAndAnEmptyRecordMakeAQuietWeek() {
        XCTAssertTrue(Door.week(lines: [], now: day(18, 12), calendar: utc).isEmpty)
        // The same week read a month later: everything is too old.
        let later = Door.week(lines: handMadeWeek(), now: day(18, 12).addingTimeInterval(30 * 86400), calendar: utc)
        XCTAssertEqual(later, DoorWeek())
        XCTAssertEqual(Door.weekSentence(later), "A quiet week. Nothing needed doing.")
        // Exactly seven days back still counts; a minute more does not.
        let edge = [line(day(11, 12), "watch-1-a", "doing the job a", true, "a: 2 steps done"), line(day(11, 11, 59), "watch-2-a", "doing the job a", true, "a: 2 steps done")]
        XCTAssertEqual(Door.week(lines: edge, now: day(18, 12), calendar: utc).chores, 1)
    }

    func testReasonsAndStepsAreReadFromThePlainWords() {
        XCTAssertEqual(Door.weekReason("open the NOTES stopped at step 1: could not find TextEdit"), "Could not find TextEdit")
        XCTAssertEqual(Door.weekReason("a: b stopped at step 12: not allowed to press yet"), "Not allowed to press yet")
        XCTAssertEqual(Door.weekReason("tidy stopped before step 3: hands off"), "Hands off was on")
        XCTAssertEqual(Door.weekReason("hands off is on, so I did not do that. Ask resume to let me work again."), "Hands off was on")
        XCTAssertEqual(Door.weekReason("that app is not running"), "That app is not running")
        XCTAssertEqual(Door.weekReason(""), "No reason was given")
        XCTAssertEqual(Door.weekSteps("open report: 5 steps done"), 5)
        XCTAssertEqual(Door.weekSteps("open report: 14 steps done, 2 not needed"), 14)
        XCTAssertEqual(Door.weekSteps("pressed OK"), 0)
        // Only the top three reasons are named; a tie is settled by the words, so the list never shuffles.
        let t = day(17, 9)
        let many = ["d", "c", "b", "a", "a"].enumerated().map { line(t, "p\($0.offset)", "pressing X", false, $0.element) }
        let w = Door.week(lines: many, now: day(18, 12), calendar: utc)
        XCTAssertEqual(w.reasons.map(\.why), ["A", "B", "C"]); XCTAssertEqual(w.failed, 5)
        XCTAssertTrue(Door.weekPage(w, host: "Test Mac", waiting: 0).contains("And 1 more for other reasons."))
    }

    func testTheBigSentenceReadsRightForOneAndForMany() {
        var w = DoorWeek(); w.answered = 4; w.chores = 7; w.covered = 2; w.presses = 60
        XCTAssertEqual(Door.weekSentence(w), "I answered 4 boxes and ran 9 chores for you this week, about 60 presses you did not have to make.")
        w = DoorWeek(); w.answered = 1; w.presses = 1
        XCTAssertEqual(Door.weekSentence(w), "I answered 1 box for you this week, about 1 press you did not have to make.")
        w = DoorWeek(); w.asked = 1; w.presses = 3
        XCTAssertEqual(Door.weekSentence(w), "I ran 1 chore for you this week, about 3 presses you did not have to make.")
        w = DoorWeek(); w.chores = 2
        XCTAssertEqual(Door.weekSentence(w), "I ran 2 chores for you this week.")
        w = DoorWeek(); w.noticed = 3
        XCTAssertEqual(Door.weekSentence(w), "I kept watch this week. Nothing needed doing by me.")
        w = DoorWeek(); w.failed = 2
        XCTAssertEqual(Door.weekSentence(w), "I did not get anything done for you this week. What got in the way is below.")
        XCTAssertEqual(Door.weekSentence(DoorWeek()), "A quiet week. Nothing needed doing.")
        XCTAssertEqual(Door.weekWaiting(0), "Nothing is waiting on you now.")
        XCTAssertEqual(Door.weekWaiting(1), "1 thing is waiting on you now.")
        XCTAssertEqual(Door.weekWaiting(3), "3 things are waiting on you now.")
    }

    func testThePageShowsOnlyWhatHappened() {
        let w = Door.week(lines: handMadeWeek(), now: day(18, 12), calendar: utc)
        let page = Door.weekPage(w, host: "Kody's <Mac>", waiting: 2)
        XCTAssertTrue(page.contains("<title>This week</title>") && page.contains("<h1>This week</h1>"))
        XCTAssertTrue(page.contains("Kody's &lt;Mac>, the last 7 days"))
        XCTAssertTrue(page.contains("<p class=\"big\">I answered 2 boxes and ran 4 chores for you this week, about 23 presses you did not have to make.</p>"))
        XCTAssertTrue(page.contains("<li><b>Boxes I answered the way you always do</b><span>2</span></li>"))
        XCTAssertTrue(page.contains("<li><b>Jobs I ran while another Mac was quiet</b><span>1</span></li>"))
        XCTAssertTrue(page.contains("What I could not do <em>7</em>"))
        XCTAssertTrue(page.contains("<li><b>Nothing on screen says Export</b><span>3 times</span></li>"))
        XCTAssertTrue(page.contains("<li><b>I have not learned fly</b><span>once</span></li>"))
        XCTAssertTrue(page.contains("2 things are waiting on you now."))
        // The big sentence comes first, then the counts, then the trouble, then what is waiting.
        let order = ["class=\"big\"", "The week in numbers", "What I could not do", "Waiting on you"].map { page.range(of: $0)!.lowerBound }
        XCTAssertEqual(order, order.sorted())
        // Zero counts are left out.
        var some = DoorWeek(); some.chores = 1; some.presses = 2
        let short = Door.weekPage(some, host: "Mac", waiting: 0)
        XCTAssertEqual(Door.weekRows(some).map(\.says), ["Chores I ran on time or when I saw the sign"])
        XCTAssertFalse(short.contains("Boxes I answered")); XCTAssertFalse(short.contains("Restarts"))
        XCTAssertTrue(short.contains("Nothing. Everything I tried worked."))
        // A quiet week is just the one sentence and what is waiting.
        let quiet = Door.weekPage(DoorWeek(), host: "Mac", waiting: 0)
        XCTAssertTrue(quiet.contains("A quiet week. Nothing needed doing.") && quiet.contains("Nothing is waiting on you now."))
        XCTAssertFalse(quiet.contains("What I could not do")); XCTAssertFalse(quiet.contains("The week in numbers"))
        // Nothing a person reads names a file or a code word.
        for word in ["json", "log", "notice-", "watch-", "cover-", "null", "nil"] { XCTAssertFalse(page.replacingOccurrences(of: "page.html", with: "").contains(word), word) }
    }

    func testTheNoteIsOwedFromMondayMorningOncePerWeek() {
        // 16 November 2026 is a Monday.
        XCTAssertEqual(utc.component(.weekday, from: day(16, 8)), 2)
        XCTAssertFalse(Door.weekDue(now: day(16, 7, 59), last: nil, calendar: utc), "not before eight")
        XCTAssertTrue(Door.weekDue(now: day(16, 8), last: nil, calendar: utc))
        XCTAssertTrue(Door.weekDue(now: day(16, 8), last: day(9, 8).timeIntervalSince1970, calendar: utc), "last week's does not count")
        XCTAssertFalse(Door.weekDue(now: day(16, 9), last: day(16, 8).timeIntervalSince1970, calendar: utc), "once")
        XCTAssertFalse(Door.weekDue(now: day(22, 23), last: day(16, 8).timeIntervalSince1970, calendar: utc), "still once on Sunday night")
        // Asleep on Monday: it is still owed on Thursday, and on Sunday.
        XCTAssertTrue(Door.weekDue(now: day(19, 3), last: day(9, 8).timeIntervalSince1970, calendar: utc))
        XCTAssertTrue(Door.weekDue(now: day(22, 23), last: day(9, 8).timeIntervalSince1970, calendar: utc))
        // Written late last week (Thursday), it is not owed again until this Monday at eight.
        XCTAssertFalse(Door.weekDue(now: day(15, 23), last: day(12, 3).timeIntervalSince1970, calendar: utc))
        XCTAssertFalse(Door.weekDue(now: day(16, 7), last: day(12, 3).timeIntervalSince1970, calendar: utc))
        XCTAssertTrue(Door.weekDue(now: day(16, 8, 1), last: day(12, 3).timeIntervalSince1970, calendar: utc))
    }

    func testItWritesItselfOnceAWeekAndCatchesUpAfterAMissedMonday() throws {
        let door = tempDoor()
        var acted: [String] = []
        door.onAct = { acted.append($0) }
        func told() -> Int { ((try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").components(separatedBy: "Your weekly note is ready.").count - 1 }
        let note = door.dir.appendingPathComponent("weekly.html")
        // Sunday night: the page is kept there for the link, but nothing is said.
        door.keepWeek(now: day(15, 22), calendar: utc)
        XCTAssertTrue(FileManager.default.fileExists(atPath: note.path)); XCTAssertEqual(told(), 0)
        // Monday before eight: still nothing. At eight: said once, however many heartbeats follow.
        door.keepWeek(now: day(16, 7, 30), calendar: utc); XCTAssertEqual(told(), 0)
        door.keepWeek(now: day(16, 8), calendar: utc); XCTAssertEqual(told(), 1)
        for i in 1..<20 { door.keepWeek(now: day(16, 8).addingTimeInterval(Double(i) * 15), calendar: utc) }
        door.keepWeek(now: day(20, 14), calendar: utc); door.keepWeek(now: day(22, 23), calendar: utc)
        XCTAssertEqual(told(), 1); XCTAssertEqual(acted, ["your weekly note is ready"])
        // The next Monday the Mac is asleep. It wakes on Wednesday and writes it then, once.
        door.keepWeek(now: day(25, 10), calendar: utc); XCTAssertEqual(told(), 2)
        door.keepWeek(now: day(25, 10, 1), calendar: utc); door.keepWeek(now: day(27, 9), calendar: utc)
        XCTAssertEqual(told(), 2)
        // It remembers across a relaunch: a new door on the same folder does not say it again.
        let again = Door(dir: door.dir, watch: false)
        again.keepWeek(now: day(27, 10), calendar: utc); XCTAssertEqual(told(), 2)
        again.keepWeek(now: day(30, 8), calendar: utc); XCTAssertEqual(told(), 3)
        // The line shows under what was noticed, in plain words.
        let last = try XCTUnwrap(try String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8).split(separator: "\n").last)
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any])
        XCTAssertTrue((o["id"] as? String ?? "").hasPrefix("notice-")); XCTAssertEqual(o["said"] as? String, "Your weekly note is ready.")
        // Its own lines never count as work done.
        XCTAssertTrue(try String(contentsOf: note, encoding: .utf8).contains("A quiet week. Nothing needed doing."))
    }

    func testAFolderThatCannotBeWrittenSaysSoAndIsNotRemembered() throws {
        let door = tempDoor()
        // Something is in the way where the note goes.
        try FileManager.default.createDirectory(at: door.dir.appendingPathComponent("weekly.html/x"), withIntermediateDirectories: true)
        let r = door.writeWeek(now: day(16, 9), calendar: utc)
        XCTAssertFalse(r.ok); XCTAssertEqual(r.said, "I could not write your weekly note")
        // Already counting from the week before, and this Monday's note is owed, but the folder is in the way.
        try JSONSerialization.data(withJSONObject: ["wrote": day(9, 9).timeIntervalSince1970]).write(to: door.dir.appendingPathComponent("week.json"))
        door.keepWeek(now: day(16, 9), calendar: utc)
        let seen = try JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("week.json"))) as? [String: Double]
        XCTAssertEqual(seen?["wrote"], day(9, 9).timeIntervalSince1970, "not remembered as written, so it tries again next heartbeat")
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("log.jsonl").path))
    }

    func testAskingForTheWeekWritesItAndAnswersWithTheSentence() async throws {
        let door = tempDoor()
        XCTAssertEqual(Door.line(DoorAsk(id: "w", do: "week")), "writing your weekly note")
        // A record with a broken line in it, and a question left open for the owner.
        let now = Date().timeIntervalSince1970 - 60
        let lines = [line(Date(timeIntervalSince1970: now), "notice-1-always1", "noticed a box waiting", true, "NoSuchAppForTests asked \"Reopen?\" and I pressed Cancel, as you always do"),
                     line(Date(timeIntervalSince1970: now), "watch-2-tidy", "doing the job tidy", true, "tidy: 4 steps done"),
                     line(Date(timeIntervalSince1970: now), "watch-3-tidy", "doing the job tidy", true, "tidy: 4 steps done")]
        var text = "this line is not a record\n"
        for l in lines { text += String(data: try JSONSerialization.data(withJSONObject: l, options: [.sortedKeys]), encoding: .utf8)! + "\n" }
        try Data(text.utf8).write(to: door.dir.appendingPathComponent("log.jsonl"))
        var q = DoorAsk(id: "q-1", do: "question"); q.title = "Restart tonight?"; q.choices = ["Yes", "Not now"]
        try drop(q, in: door); try drop(DoorAsk(id: "p1", do: "page"), in: door)
        await door.drain()
        try drop(DoorAsk(id: "wk1", do: "week"), in: door)
        await door.drain()
        let got = try JSONDecoder().decode(DoorAnswer.self, from: Data(contentsOf: door.dir.appendingPathComponent("wk1.answer.json")))
        XCTAssertTrue(got.ok)
        XCTAssertEqual(got.said, "I answered 1 box and ran 2 chores for you this week, about 9 presses you did not have to make.")
        let note = try String(contentsOf: door.dir.appendingPathComponent("weekly.html"), encoding: .utf8)
        XCTAssertTrue(note.contains(got.said) && note.contains("1 thing is waiting on you now."))
        // Asking by hand does not use up the week's own note.
        XCTAssertFalse(FileManager.default.fileExists(atPath: door.dir.appendingPathComponent("week.json").path))
        // The main page links to it near the top.
        let page = try String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)
        let link = try XCTUnwrap(page.range(of: "<a href=\"weekly.html\" style=\"color:#f0a04b\">This week</a>"))
        XCTAssertLessThan(link.lowerBound, try XCTUnwrap(page.range(of: "Left for you")).lowerBound)
        XCTAssertTrue(DoorWeb.forWeb(page).contains(">This week</a>"), "the link survives the page going over the network")
    }
}
