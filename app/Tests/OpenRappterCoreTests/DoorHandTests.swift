import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorHandTests: XCTestCase {
    func door() -> Door { Door(dir: FileManager.default.temporaryDirectory.appendingPathComponent("door-\(UUID().uuidString)"), watch: false) }
    func log(_ d: Door) -> String { (try? String(contentsOf: d.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "" }
    func req(_ h: [String: String], _ body: String = "{}") -> DoorWeb.Request { .init(method: "POST", path: "/hand", headers: h, body: Data(body.utf8)) }

    func testOnlyPlainAsksAreTaken() {
        XCTAssertEqual(Door.handAsk(Data(#"{"do":"tap","x":0.5,"y":0.25}"#.utf8)), .tap(0.5, 0.25))
        XCTAssertNil(Door.handAsk(Data(#"{"do":"tap","x":1.5,"y":0.2}"#.utf8)))
        XCTAssertEqual(Door.handAsk(Data(#"{"do":"type","text":"hello"}"#.utf8)), .type("hello"))
        XCTAssertNil(Door.handAsk(Data(#"{"do":"type","text":""}"#.utf8)))
        XCTAssertEqual(Door.handAsk(Data(#"{"do":"key","key":"return"}"#.utf8)), .key("return"))
        XCTAssertNil(Door.handAsk(Data(#"{"do":"key","key":"q"}"#.utf8)))
        XCTAssertNil(Door.handAsk(Data(#"{"do":"open","text":"Terminal"}"#.utf8)))
    }

    func testATapLandsInTheRightPlace() {
        XCTAssertEqual(Door.handPoint(0.5, 0.25, bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080)), CGPoint(x: 960, y: 270))
    }

    func testWhatYouTypeIsNeverWrittenDown() {
        let d = door(); var got: Door.HandAsk?
        let r = d.hand(.type("hunter2-secret"), act: { got = $0 })
        XCTAssertTrue(r.ok); XCTAssertEqual(got, .type("hunter2-secret"))
        XCTAssertTrue(log(d).contains("typed 14 characters from your phone"))
        XCTAssertFalse(log(d).contains("hunter2"))
    }

    func testHandsOffMeansNoTouching() {
        let d = door(); try? FileManager.default.createDirectory(at: d.dir, withIntermediateDirectories: true); FileManager.default.createFile(atPath: d.holdURL.path, contents: Data()); var touched = false
        XCTAssertFalse(d.hand(.tap(0.1, 0.1), act: { _ in touched = true }).ok)
        XCTAssertFalse(touched)
    }

    func testAnotherSiteCannotPressForYou() {
        let ok = ["content-type": "application/json", "x-door": "hand", "host": "100.1.2.3:7466", "origin": "http://100.1.2.3:7466"]
        XCTAssertTrue(DoorWeb.handAllowed(req(ok)))
        var other = ok; other["origin"] = "https://evil.example"
        XCTAssertFalse(DoorWeb.handAllowed(req(other)))
        var form = ok; form["content-type"] = "application/x-www-form-urlencoded"
        XCTAssertFalse(DoorWeb.handAllowed(req(form)))
        var bare = ok; bare.removeValue(forKey: "x-door")
        XCTAssertFalse(DoorWeb.handAllowed(req(bare)))
    }

    func testTheScreenBecomesThingsYouCanSay() {
        let words = ["Window: iCloud @1550,519", "StaticText: iCloud Drive @1000,398", "Button: Sign In @1000,629",
                     "Button: com.apple.systempreferences.general.featureDescription @716,391", "Button: Sign In @1000,629",
                     "SecureTextField: Password @960,500", "Switch: Wi-Fi (on) @100,100", "Button: Far away @5000,5000"]
        let c = Door.handChoices(words, bounds: CGRect(x: 0, y: 0, width: 2000, height: 1250))
        XCTAssertEqual(c.map(\.label), ["Wi-Fi", "Password", "Sign In"])
        XCTAssertEqual(c[1].kind, "field"); XCTAssertEqual(c[2].x, 0.5, accuracy: 0.001)
    }

    func testWhatYouSayFindsTheButton() {
        let labels = ["Sign In", "Learn more about iCloud Drive", "Cancel"]
        XCTAssertEqual(Door.handHeard("press sign in", in: labels), "Sign In")
        XCTAssertEqual(Door.handHeard("cancel", in: labels), "Cancel")
        XCTAssertEqual(Door.handHeard("learn more", in: labels), "Learn more about iCloud Drive")
        XCTAssertNil(Door.handHeard("banana", in: labels))
        XCTAssertEqual(Door.handAsk(Data(#"{"do":"press","label":"Sign In"}"#.utf8)), .press("Sign In"))
    }

    func testThePageHidesTypingByDefault() {
        let p = DoorWeb.handPage(mac: "Rappter <One>")
        XCTAssertTrue(p.contains(#"type="password""#)); XCTAssertTrue(p.contains("Rappter &lt;One>"))
    }
}
