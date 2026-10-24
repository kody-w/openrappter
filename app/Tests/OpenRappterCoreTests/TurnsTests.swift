import XCTest
@testable import OpenRappterCore

final class TurnsTests: XCTestCase {
    func testANewTurnRetiresTheOldOne() {
        var t = Turns()
        let a = t.begin()
        XCTAssertTrue(t.isLive(a))
        let b = t.begin()
        XCTAssertFalse(t.isLive(a), "the old turn's tail must not touch the creature")
        XCTAssertTrue(t.isLive(b))
        XCTAssertNotEqual(a, b)
    }

    func testHoldStartsAndStops() {
        var g = PressGate(tapLimit: 0.3)
        let t0 = Date()
        XCTAssertEqual(g.keyDown(at: t0), .start)
        XCTAssertTrue(g.wantsListening)
        XCTAssertEqual(g.keyUp(at: t0.addingTimeInterval(0.8)), .stop)
        XCTAssertFalse(g.wantsListening)
        XCTAssertFalse(g.latched)
    }

    func testExactlyTheLimitIsAHold() {
        var g = PressGate(tapLimit: 0.3)
        let t0 = Date()
        _ = g.keyDown(at: t0)
        XCTAssertEqual(g.keyUp(at: t0.addingTimeInterval(0.3)), .stop)
    }

    func testTapLatchesAndNextTapStops() {
        var g = PressGate(tapLimit: 0.3)
        let t0 = Date()
        XCTAssertEqual(g.keyDown(at: t0), .start)
        XCTAssertEqual(g.keyUp(at: t0.addingTimeInterval(0.1)), .latch)
        XCTAssertTrue(g.wantsListening, "a tap leaves listening on")
        XCTAssertTrue(g.latched)
        // The next press does not start a second listen; its release ends the first.
        XCTAssertEqual(g.keyDown(at: t0.addingTimeInterval(3)), .ignore)
        XCTAssertTrue(g.wantsListening)
        XCTAssertEqual(g.keyUp(at: t0.addingTimeInterval(3.1)), .stop)
        XCTAssertFalse(g.wantsListening)
        XCTAssertFalse(g.latched)
    }

    func testReleaseDuringThePermissionWaitLeavesNothingWanting() {
        // Key down, then up before listening ever started: the start must find wantsListening false.
        var g = PressGate()
        _ = g.keyDown(at: Date())
        _ = g.keyUp(at: Date().addingTimeInterval(1))
        XCTAssertFalse(g.wantsListening)
        XCTAssertEqual(g.keyUp(at: Date()), .stop, "a stray release is harmless")
    }

    func testResetForgetsALatch() {
        var g = PressGate()
        let t0 = Date()
        _ = g.keyDown(at: t0); _ = g.keyUp(at: t0.addingTimeInterval(0.05))
        XCTAssertTrue(g.latched)
        g.reset()
        XCTAssertFalse(g.wantsListening)
        XCTAssertEqual(g.keyDown(at: t0.addingTimeInterval(1)), .start, "after a reset a press starts fresh")
    }

    func testCodeIsSpelledOneCharacterAtATime() {
        XCTAssertEqual(SpokenCode.spell("ABCD-1234"), "A, B, C, D, dash, 1, 2, 3, 4")
        XCTAssertEqual(SpokenCode.spell("3FA0-965E"), "3, F, A, zero, dash, 9, 6, 5, E")
        XCTAssertEqual(SpokenCode.spell(""), "")
    }
}
