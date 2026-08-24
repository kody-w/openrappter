import Foundation
import Observation

/// CMR/1 — the committed-message reveal.
///
/// Response deltas are useful for liveness, so they are consumed; they are
/// just never shown. Partial language stays in a private buffer, the operator
/// sees a stable presence bubble, and one atomic commit reveals the finished
/// message. Cancellation or error discards the uncommitted draft entirely, so
/// no half-sentence ever survives a failure.
@Observable
final class CommittedMessageBuffer {
    enum Phase: Equatable {
        case idle
        case present
        case committed(String)
        case failed(String)
        case cancelled
    }

    private(set) var phase: Phase = .idle
    /// Private on purpose. Nothing in the view layer can read this.
    private var draft = ""
    /// Liveness only: how many deltas arrived, never what they said.
    private(set) var deltaCount = 0

    var isReceiving: Bool { phase == .present }

    /// The only text a view is ever allowed to render.
    var revealedText: String? {
        if case let .committed(text) = phase { return text }
        return nil
    }

    var failure: String? {
        if case let .failed(message) = phase { return message }
        return nil
    }

    func begin() {
        draft = ""
        deltaCount = 0
        phase = .present
    }

    /// Absorbs a delta into the private buffer. Never changes what is visible.
    func absorb(_ delta: String) {
        guard phase == .present else { return }
        draft += delta
        deltaCount += 1
    }

    /// The atomic reveal. A commit with no buffered text and no final text is
    /// a failure, not an empty bubble.
    func commit(final: String? = nil) {
        guard phase == .present else { return }
        let text = (final ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        if text.isEmpty {
            phase = .failed("The companion finished without saying anything.")
        } else {
            phase = .committed(text)
        }
    }

    func fail(_ message: String) {
        draft = ""
        phase = .failed(message)
    }

    func cancel() {
        draft = ""
        deltaCount = 0
        phase = .cancelled
    }

    func reset() {
        draft = ""
        deltaCount = 0
        phase = .idle
    }

    /// Test-only window onto the private buffer, so the invariant that it is
    /// discarded can actually be asserted.
    var bufferedCharacterCountForTesting: Int { draft.count }
}

enum ChatEvent: Equatable {
    case delta(String)
    case final(String)
    case failed(String)
}

protocol CompanionChatService {
    func respond(to prompt: String, companion: Companion) -> AsyncStream<ChatEvent>
}

/// The offline companion voice.
///
/// It streams deltas exactly like a host would, so the committed-message path
/// is exercised for real rather than faked with a single final event.
struct LocalCompanionChat: CompanionChatService {
    var tickDelay: Duration = .milliseconds(90)

    func respond(to prompt: String, companion: Companion) -> AsyncStream<ChatEvent> {
        let reply = LocalCompanionChat.reply(to: prompt, companion: companion)
        let delay = tickDelay
        return AsyncStream { continuation in
            let task = Task {
                for chunk in LocalCompanionChat.chunks(of: reply) {
                    if Task.isCancelled { break }
                    try? await Task.sleep(for: delay)
                    continuation.yield(.delta(chunk))
                }
                if Task.isCancelled {
                    continuation.finish()
                    return
                }
                continuation.yield(.final(reply))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func chunks(of text: String) -> [String] {
        text.split(separator: " ", omittingEmptySubsequences: false).map { String($0) + " " }
    }

    static func reply(to prompt: String, companion: Companion) -> String {
        let stats = companion.stats
        let question = prompt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        if question.contains("weigh") || question.contains("heavy") || question.contains("size") {
            if let total = stats.totalWeightBytes {
                return """
                I weigh exactly \(Formatting.exactBytes(total)), counted once over each unique \
                verified address. Every dimension I carry has a known size, so that number is exact.
                """
            }
            return """
            My weight is incomplete. I can account for \
            \(Formatting.exactBytes(stats.residentWeightBytes + stats.linkedWeightBytes)) of verified \
            content, but \(stats.unmeasuredDimensions.joined(separator: ", ")) has never been measured \
            in this habitat, so I will not hand you a total I would have to invent.
            """
        }
        if question.contains("grow") || question.contains("next") {
            return """
            My accepted frame depth is \(stats.frameHeight). I can read what might come next, \
            but a reading is not a fact about me: nothing changes until you approve it and a \
            host appends a verified frame.
            """
        }
        if question.contains("who") || question.contains("name") || question.contains("you") {
            return """
            I am \(companion.displayName), a \(companion.moltName) on the \(companion.path.displayName) path. \
            The name and the stage are how you see me; \(companion.identity.shortHex)… is who I am, and \
            that has not changed since I was minted.
            """
        }
        if question.contains("sound") || question.contains("sing") || question.contains("call") {
            return """
            My wake call comes from a 16-note motif derived from my identity and my birth traits. \
            It is the same sixteen notes on any device, offline, forever — press Play and you will \
            hear exactly what anyone else holding me hears.
            """
        }
        return """
        I heard you. I am \(companion.displayName), \(companion.moltName) on the \(companion.path.displayName) path, \
        carrying \(companion.dimensions.count) dimension families at frame depth \(stats.frameHeight). \
        Ask me about my weight, how I grow, what I sound like, or who I am.
        """
    }
}
