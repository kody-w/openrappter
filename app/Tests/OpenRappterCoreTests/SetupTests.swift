import XCTest
@testable import OpenRappterCore

final class SetupTests: XCTestCase {
    func testFakeOverridesParse() {
        let d = Powers.parseFake("typing:notAsked, screen:denied,bogus:x,microphone:nope")
        XCTAssertEqual(d[.typing], .notAsked)
        XCTAssertEqual(d[.screen], .denied)
        XCTAssertNil(d[.microphone])
        XCTAssertEqual(d.count, 2)
    }

    func testNextFollowsAskingOrder() {
        var s: [Power: PowerState] = [.microphone: .granted, .speech: .granted, .typing: .notAsked, .screen: .denied]
        XCTAssertEqual(Powers.next(s), .typing)
        s[.typing] = .granted
        XCTAssertEqual(Powers.next(s), .screen)
        s[.screen] = .granted
        XCTAssertNil(Powers.next(s))
        XCTAssertTrue(Powers.allGranted(s))
        XCTAssertFalse(Powers.allGranted([:]))
    }

    func testEveryPowerHasPlainWordsAndASettingsPane() {
        for p in Power.allCases {
            XCTAssertFalse(p.title.isEmpty); XCTAssertFalse(p.why.isEmpty)
            XCTAssertTrue(p.settingsURL.absoluteString.hasPrefix("x-apple.systempreferences:com.apple.preference.security?Privacy_"))
            XCTAssertFalse(p.title.lowercased().contains("ai"))
        }
    }
}
