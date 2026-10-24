import XCTest
@testable import OpenRappterCore

final class SensesTests: XCTestCase {
    func testNoMarkers() {
        XCTAssertEqual(Senses.parse("  hi there \n"), ParsedSenses(text: "hi there", senses: [:]))
    }
    func testEmpty() {
        XCTAssertEqual(Senses.parse(""), ParsedSenses(text: "", senses: [:]))
    }
    func testVoiceBlock() {
        let p = Senses.parse("Hello, Kody! Good to see you.\n\n|||VOICE||| Hello Kody, good to see you.")
        XCTAssertEqual(p.text, "Hello, Kody! Good to see you.")
        XCTAssertEqual(p.voice, "Hello Kody, good to see you.")
    }
    func testManyBlocksLowercasedAndEmptyDropped() {
        let p = Senses.parse("main|||VOICE|||spoken|||HOLO|||  |||TLDR|||short")
        XCTAssertEqual(p.text, "main")
        XCTAssertEqual(p.senses, ["voice": "spoken", "tldr": "short"])
    }
    func testDuplicateTagLastWins() {
        XCTAssertEqual(Senses.parse("a|||VOICE|||one|||VOICE|||two").voice, "two")
    }
    func testLowercaseTagIsNotAMarker() {
        XCTAssertEqual(Senses.parse("x |||voice||| y").text, "x |||voice||| y")
    }
    func testPostureTintDistinct() {
        XCTAssertEqual(Set(Posture.allCases.map(\.label)).count, Posture.allCases.count)
    }
}
