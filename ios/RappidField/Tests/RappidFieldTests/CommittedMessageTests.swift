import XCTest
@testable import RappidField

/// CMR/1: deltas are consumed for liveness and never rendered; a message
/// appears whole or not at all.
@MainActor
final class CommittedMessageTests: XCTestCase {
    func testDeltasAreNeverVisibleBeforeTheCommit() {
        let buffer = CommittedMessageBuffer()
        buffer.begin()
        XCTAssertTrue(buffer.isReceiving)
        XCTAssertNil(buffer.revealedText)

        buffer.absorb("I am ")
        buffer.absorb("Mossline, ")
        buffer.absorb("a Strider.")
        XCTAssertNil(buffer.revealedText, "no partial text may ever be readable")
        XCTAssertEqual(buffer.deltaCount, 3, "liveness is counted, not shown")
        XCTAssertEqual(buffer.bufferedCharacterCountForTesting, 25)

        buffer.commit()
        XCTAssertEqual(buffer.revealedText, "I am Mossline, a Strider.")
        XCTAssertFalse(buffer.isReceiving)
        XCTAssertEqual(buffer.bufferedCharacterCountForTesting, 0, "the draft is released on commit")
    }

    func testFinalEventWinsOverTheAccumulatedDraft() {
        let buffer = CommittedMessageBuffer()
        buffer.begin()
        buffer.absorb("partial ")
        buffer.commit(final: "The whole message.")
        XCTAssertEqual(buffer.revealedText, "The whole message.")
    }

    func testCancelDiscardsTheDraftEntirely() {
        let buffer = CommittedMessageBuffer()
        buffer.begin()
        buffer.absorb("half a thought")
        buffer.cancel()

        XCTAssertEqual(buffer.phase, .cancelled)
        XCTAssertNil(buffer.revealedText)
        XCTAssertEqual(buffer.bufferedCharacterCountForTesting, 0)
        XCTAssertEqual(buffer.deltaCount, 0)

        // A commit after a cancel cannot resurrect anything.
        buffer.commit(final: "too late")
        XCTAssertNil(buffer.revealedText)
    }

    func testFailureDiscardsTheDraftAndIsSurfaced() {
        let buffer = CommittedMessageBuffer()
        buffer.begin()
        buffer.absorb("half a thought")
        buffer.fail("the host closed the connection")

        XCTAssertEqual(buffer.failure, "the host closed the connection")
        XCTAssertNil(buffer.revealedText)
        XCTAssertEqual(buffer.bufferedCharacterCountForTesting, 0)
    }

    func testEmptyCommitIsAFailureNotAnEmptyBubble() {
        let buffer = CommittedMessageBuffer()
        buffer.begin()
        buffer.commit()
        XCTAssertNil(buffer.revealedText)
        XCTAssertNotNil(buffer.failure)
    }

    func testAbsorbOutsideAnExchangeIsIgnored() {
        let buffer = CommittedMessageBuffer()
        buffer.absorb("stray delta")
        XCTAssertEqual(buffer.bufferedCharacterCountForTesting, 0)
        XCTAssertEqual(buffer.phase, .idle)
    }

    func testViewModelRevealsOneWholeMessage() async throws {
        let model = ChatViewModel(service: LocalCompanionChat(tickDelay: .zero))
        let companion = SyntheticField.companion(for: .canopy)
        model.ask("Who are you?", companion: companion)

        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages.first?.role, .operatorSide)

        try await waitUntil { model.messages.count == 2 }
        let reply = try XCTUnwrap(model.messages.last)
        XCTAssertEqual(reply.role, .companion)
        XCTAssertTrue(reply.text.contains(companion.displayName))
        XCTAssertTrue(reply.text.contains(companion.moltName))
        XCTAssertFalse(model.isReceiving)
        XCTAssertNil(model.buffer.revealedText, "the buffer is reset once the message is harvested")
    }

    func testCancellingLeavesNoPartialMessageBehind() async throws {
        let model = ChatViewModel(service: LocalCompanionChat(tickDelay: .milliseconds(40)))
        let companion = SyntheticField.companion(for: .forge)
        model.ask("What do you weigh?", companion: companion)
        XCTAssertTrue(model.isReceiving)

        try await Task.sleep(for: .milliseconds(120))
        model.cancel()

        XCTAssertFalse(model.isReceiving)
        XCTAssertEqual(model.messages.count, 1, "only the operator's own line remains")
        XCTAssertEqual(model.messages.first?.role, .operatorSide)
        XCTAssertEqual(model.buffer.bufferedCharacterCountForTesting, 0)

        // Nothing arrives late either.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.messages.count, 1)
    }

    func testIncompleteWeightIsSpokenAsIncomplete() {
        let forge = SyntheticField.companion(for: .forge)
        let reply = LocalCompanionChat.reply(to: "what do you weigh?", companion: forge)
        XCTAssertTrue(reply.contains("incomplete"))
        XCTAssertFalse(reply.lowercased().contains("about "), "an incomplete weight is never approximated")

        let canopy = SyntheticField.companion(for: .canopy)
        let exact = LocalCompanionChat.reply(to: "what do you weigh?", companion: canopy)
        XCTAssertTrue(exact.contains("B"))
        XCTAssertTrue(exact.contains("exact"))
    }

    private func waitUntil(
        timeout: Duration = .seconds(5),
        _ condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("condition not met within \(timeout)")
    }
}
