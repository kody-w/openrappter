import AppKit
import AVFoundation
import XCTest
@testable import OpenRappterCore

@MainActor
final class AudioCaptureTests: XCTestCase {
    func testInvalidFormatsNeverInstallTap() {
        for (rate, channels) in [(0.0, UInt32(0)), (48000, 0), (0, 1), (.nan, 1)] {
            var installed = 0, started = 0
            let capture = MicrophoneCapture(format: { (rate, channels) }, install: { _ in installed += 1 },
                                            start: { started += 1 }, stop: {}, remove: {})
            XCTAssertThrowsError(try capture.start { _ in })
            XCTAssertFalse(capture.hasTap)
            XCTAssertEqual(installed, 0)
            XCTAssertEqual(started, 0)
        }
    }

    func testFailedStartRemovesTapAndCanRetry() throws {
        var fail = true, installed = 0, removed = 0, stopped = 0
        let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in
            XCTAssertEqual(installed, removed, "Never install over an existing tap")
            installed += 1
        }, start: { if fail { throw EarsError.unavailable } }, stop: { stopped += 1 }, remove: { removed += 1 })
        XCTAssertThrowsError(try capture.start { _ in })
        XCTAssertFalse(capture.hasTap)
        XCTAssertEqual(removed, 1)
        fail = false
        try capture.start { _ in }
        XCTAssertTrue(capture.hasTap)
        XCTAssertThrowsError(try capture.start { _ in })
        capture.stop(); capture.stop()
        XCTAssertEqual(installed, 2)
        XCTAssertEqual(removed, 2)
        XCTAssertGreaterThanOrEqual(stopped, 2)
    }
}

@MainActor
final class ClipboardLeaseTests: XCTestCase {
    @MainActor final class Board {
        var items: ClipboardLease.Snapshot = []
        var version = 0
        func write(_ value: ClipboardLease.Snapshot) { items = value; version += 1 }
        func lease() -> ClipboardLease {
            ClipboardLease(read: { self.items }, write: { self.write($0) }, version: { self.version })
        }
    }

    func testSignInRestoresAllClipboardKinds() {
        let board = Board()
        let original = [["public.utf8-plain-text": Data("A paragraph".utf8), "public.rtf": Data([1, 2, 3])],
                        ["public.png": Data([4, 5, 6])]]
        board.write(original)
        let lease = board.lease()
        lease.copy("ABCD-1234")
        XCTAssertNotEqual(board.items, original)
        lease.copy("ABCD-1234")
        lease.restore()
        XCTAssertEqual(board.items, original, "Repeated sign-in must not replace the saved clipboard with the code")
        lease.restore()
        XCTAssertEqual(board.items, original)
    }

    func testSignInDoesNotClobberSomethingCopiedMeanwhile() {
        let board = Board()
        board.write([["text": Data("old".utf8)]])
        let lease = board.lease()
        lease.copy("ABCD-1234")
        let newer = [["text": Data("new".utf8)]]
        board.write(newer)
        lease.restore()
        XCTAssertEqual(board.items, newer)
        lease.copy("ABCD-1234")
        board.write([["text": Data("newer still".utf8)]])
        let latest = board.items
        lease.copy("ABCD-1234")
        lease.restore()
        XCTAssertEqual(board.items, latest, "Re-showing a code preserves the most recent owner copy")
    }

    func testEmptyClipboardIsRestoredToo() {
        let board = Board()
        let temporary = board.lease()
        temporary.copy("code"); temporary.restore()
        XCTAssertEqual(board.items, [])
    }
}

@MainActor
final class VoiceTests: XCTestCase {
    func testOverlappingSpeechResumesOldWaiterAndIgnoresOldCallbacks() async {
        var utterances: [AVSpeechUtterance] = []
        let firstStarted = expectation(description: "First speech")
        let secondStarted = expectation(description: "Second speech")
        let voice = Voice(output: {
            utterances.append($0)
            (utterances.count == 1 ? firstStarted : secondStarted).fulfill()
        }, stop: {})
        var firstFinished = false, secondFinished = false
        let first = Task { await voice.speak("First"); firstFinished = true }
        await fulfillment(of: [firstStarted], timeout: 2)
        let second = Task { await voice.speak("Second"); secondFinished = true }
        await fulfillment(of: [secondStarted], timeout: 2)
        await first.value
        XCTAssertTrue(firstFinished)
        XCTAssertFalse(secondFinished)
        voice.complete(ObjectIdentifier(utterances[0]))
        XCTAssertFalse(secondFinished)
        voice.complete(ObjectIdentifier(utterances[1]))
        await second.value
        XCTAssertTrue(secondFinished)
    }

    func testStopAndCancellationReleaseSpeechWithoutDelegateCallbacks() async {
        let started = expectation(description: "Speech started")
        let voice = Voice(output: { _ in started.fulfill() }, stop: {})
        let task = Task { await voice.speak("Words") }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await task.value
        voice.stop()
    }
}

final class CreatureMenuTests: XCTestCase {
    func testMenuActionsAreEnabledAndAdvancedHelperIsTuckedAway() {
        let entries = CreatureMenu.entries
        XCTAssertFalse(entries.contains { $0.command == .connectHelper })
        let advanced = entries.first { $0.title == "More" }
        XCTAssertEqual(advanced?.children.first?.command, .connectHelper)
        let all = entries + entries.flatMap(\.children)
        XCTAssertEqual(Set(all.compactMap(\.command)), Set(CreatureMenuCommand.allCases))
        for entry in all {
            XCTAssertTrue(entry.command != nil || !entry.children.isEmpty, "No disabled instructional headers")
            XCTAssertEqual(OwnerWords.plain(entry.title), entry.title)
            XCTAssertFalse(entry.title.contains("Claude Code"))
            XCTAssertFalse(entry.title.contains("Full Disk Access"))
        }
        XCTAssertTrue(entries.contains { $0.command == .help })
        XCTAssertTrue(entries.contains { $0.command == .stopAtLogin })
    }
}
