import XCTest
@testable import OpenRappterCore

final class SenseKitTests: XCTestCase {
    private func tmp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("senses-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true); return d
    }

    func testValidSpecs() {
        XCTAssertTrue(SenseKit.valid(SenseSpec(tag: "WINGMAN", ask: "what to tell Wingman")))
        for bad in ["wingman", "W", "9LIVES", "HAS SPACE", "WAYTOOLONGFORAMARKERTAG"] { XCTAssertFalse(SenseKit.valid(SenseSpec(tag: bad, ask: "x")), bad) }
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "OK", ask: "")))
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "OK", ask: "two\nlines")))
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "OK", ask: "sneaks a |||VOICE||| marker")))
    }

    func testLoadSkipsBrokenFilesAndCaps() {
        let d = tmp()
        try! #"{"tag":"WINGMAN","ask":"what to tell Wingman","button":true}"#.write(to: d.appendingPathComponent("b-wingman.json"), atomically: true, encoding: .utf8)
        try! "not json".write(to: d.appendingPathComponent("a-broken.json"), atomically: true, encoding: .utf8)
        try! #"{"tag":"bad tag","ask":"x"}"#.write(to: d.appendingPathComponent("c-bad.json"), atomically: true, encoding: .utf8)
        try! #"{"tag":"WINGMAN","ask":"a second one"}"#.write(to: d.appendingPathComponent("d-twice.json"), atomically: true, encoding: .utf8)
        try! "ignored".write(to: d.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
        XCTAssertEqual(SenseKit.load(dir: d), [SenseSpec(tag: "WINGMAN", ask: "what to tell Wingman", button: true)])
        for i in 0..<12 { try! #"{"tag":"EXT\#(i)","ask":"x"}"#.write(to: d.appendingPathComponent("z\(i).json"), atomically: true, encoding: .utf8) }
        XCTAssertEqual(SenseKit.load(dir: d).count, SenseKit.maxExtensions)
        XCTAssertEqual(SenseKit.load(dir: d.appendingPathComponent("missing")), [])
    }

    func testAnExtensionNeverReplacesABuiltIn() {
        let m = SenseKit.merged(SenseKit.open, [SenseSpec(tag: "VOICE", ask: "say something else"), SenseSpec(tag: "WINGMAN", ask: "x")])
        XCTAssertEqual(m.map(\.tag), ["VOICE", "GLANCE", "WINGMAN"]); XCTAssertEqual(m[0], SenseKit.voice)
    }

    func testInstructionNamesEveryMarker() {
        let t = SenseKit.instruction(SenseKit.open + [SenseSpec(tag: "WINGMAN", ask: "what to tell Wingman")])
        for tag in ["|||VOICE|||", "|||GLANCE|||", "|||WINGMAN||| what to tell Wingman"] { XCTAssertTrue(t.contains(tag), tag) }
    }

    func testReadKeepsOnlyWhatWasAskedFor() {
        let s = SenseKit.read("ignored text |||VOICE||| Backup is done. |||GLANCE||| Backup done |||SECRET||| not asked |||MOOD|||", specs: SenseKit.open)
        XCTAssertEqual(s.values, ["VOICE": "Backup is done.", "GLANCE": "Backup done"]); XCTAssertEqual(s["voice"], "Backup is done.")
        XCTAssertEqual(SenseKit.read("|||VOICE||| " + String(repeating: "a", count: 900), specs: SenseKit.open)["VOICE"].count, SenseKit.maxValue)
    }

    func testButtonsAreOnlyAskOrSecureLinks() {
        XCTAssertEqual(SenseKit.button("Open Apple => open:https://developer.apple.com/account"), NeedOption(label: "Open Apple", action: "open:https://developer.apple.com/account"))
        XCTAssertEqual(SenseKit.button("Free space => ask: clean up my Downloads folder"), NeedOption(label: "Free space", action: "ask:clean up my Downloads folder"))
        for bad in ["no arrow", "X => open:http://plain.example.com", "X => open:file:///etc/passwd", "X => open:https://nodot", "X => run:rm -rf /",
                    "X => restart:1:x", "X => park:1:2", " => ask:hi", "X => ask:", String(repeating: "L", count: 33) + " => ask:hi", "A => ask:b => ask:c"] {
            XCTAssertNil(SenseKit.button(bad), bad)
        }
    }

    func testFirstButtonComesFromSensesMarkedAsButtons() {
        let specs = SenseKit.open + [SenseSpec(tag: "NEXT", ask: "x", button: true), SenseSpec(tag: "WINGMAN", ask: "x", button: true)]
        let s = Sensed(values: ["VOICE": "A => ask:from voice", "NEXT": "nothing useful", "WINGMAN": "Tell Wingman => ask:tell Wingman to pause"])
        XCTAssertEqual(SenseKit.button(s, specs: specs), NeedOption(label: "Tell Wingman", action: "ask:tell Wingman to pause"))
    }

    func testAnExtensionCanShowALineAndOfferItsOwnButton() {
        let bet = SenseSpec(tag: "BET", ask: "the bet", show: true, press: "Call it => ask:Check this and settle the bet: {value}")
        XCTAssertTrue(SenseKit.valid(bet))
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "BAD", ask: "x", press: "Run => run:{value}")), "a press that is not ask or a secure link is refused")
        let s = Sensed(values: ["BET": "90% sure, 35 of 104 points:\nthe backup finished => trust me"])
        XCTAssertEqual(SenseKit.lines(s, specs: [bet]), ["90% sure, 35 of 104 points: the backup finished => trust me"])
        XCTAssertEqual(SenseKit.buttons(s, specs: [bet]), [NeedOption(label: "Call it", action: "ask:Check this and settle the bet: 90% sure, 35 of 104 points: the backup finished to trust me")])
        XCTAssertEqual(SenseKit.buttons(Sensed(), specs: [bet]), [])
        let long = SenseKit.pressed(bet.press!, value: String(repeating: "word ", count: 80))
        XCTAssertNotNil(long, "long words are cut to fit, never refused"); XCTAssertLessThanOrEqual(long!.action!.count, 204)
    }

    func testAnExtensionCanFollowThroughWithOneMoreChat() {
        let bet = SenseSpec(tag: "BET", ask: "the bet", show: true, press: "Call it => ask:settle: {value}", then: "Place this bet with TrustGate: {value}")
        XCTAssertTrue(SenseKit.valid(bet))
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "BAD", ask: "x", then: "no value slot")))
        XCTAssertFalse(SenseKit.valid(SenseSpec(tag: "BAD", ask: "x", then: "sneak |||VOICE||| {value}")))
        let s = Sensed(values: ["BET": "90% | the backup finished"])
        XCTAssertEqual(SenseKit.followThrough(s, specs: [SenseKit.voice, bet])?.message, "Place this bet with TrustGate: 90% | the backup finished")
        let placed = SenseKit.followed(s, tag: "bet", answer: "\n 90% sure, 37 of 104 points: the backup finished \nmore words")
        XCTAssertEqual(placed["BET"], "90% sure, 37 of 104 points: the backup finished")
        XCTAssertEqual(SenseKit.followed(s, tag: "BET", answer: "  \n "), s, "an empty answer changes nothing")
        let un = Sensed(values: ["BET": "Unverified: I only relayed it"])
        XCTAssertNil(SenseKit.followThrough(un, specs: [bet]), "nothing is bet on an unverified claim")
        XCTAssertEqual(SenseKit.buttons(un, specs: [bet]), [], "and there is nothing to call")
        XCTAssertEqual(SenseKit.lines(un, specs: [bet]), ["Unverified: I only relayed it"], "but the owner still sees the word")
        XCTAssertNil(SenseKit.followThrough(Sensed(), specs: [bet]))
    }

    func testTheRealBetFileIsValid() throws {
        let u = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/senses/bet.json")
        guard let d = try? Data(contentsOf: u) else { throw XCTSkip("no bet.json on this Mac") }
        XCTAssertTrue(SenseKit.valid(try JSONDecoder().decode(SenseSpec.self, from: d)))
    }

    func testRecordAppendsOneLinePerReply() throws {
        let d = tmp().appendingPathComponent("made-on-demand")
        SenseKit.record(Sensed(values: [:]), about: "nothing", dir: d)
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.appendingPathComponent("sensed.jsonl").path))
        SenseKit.record(Sensed(values: ["VOICE": "one"]), about: "updates", dir: d)
        SenseKit.record(Sensed(values: ["VOICE": "two", "WINGMAN": "x"]), about: "updates", dir: d)
        let lines = try String(contentsOf: d.appendingPathComponent("sensed.jsonl"), encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        let last = try JSONSerialization.jsonObject(with: Data(lines[1].utf8)) as! [String: Any]
        XCTAssertEqual(last["schema"] as? String, "openrappter-sensed/1"); XCTAssertEqual((last["senses"] as? [String: String])?["WINGMAN"], "x")
    }
}
