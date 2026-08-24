import Foundation
import Observation

/// CMR/1 at the screen level.
///
/// The view model owns the private buffer and the task feeding it. The view
/// can only ever read a committed message, so there is no path by which a
/// partial sentence reaches a reader.
@MainActor
@Observable
final class ChatViewModel {
    struct Message: Identifiable, Equatable {
        enum Role: Equatable { case operatorSide, companion }
        let id = UUID()
        let role: Role
        let text: String
        let at: Date
    }

    private(set) var messages: [Message] = []
    var input = ""
    let buffer = CommittedMessageBuffer()

    private var task: Task<Void, Never>?
    private let service: CompanionChatService

    init(service: CompanionChatService = LocalCompanionChat()) {
        self.service = service
    }

    var isReceiving: Bool { buffer.isReceiving }
    var failure: String? { buffer.failure }

    func send(companion: Companion) {
        let prompt = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isReceiving else { return }
        input = ""
        messages.append(Message(role: .operatorSide, text: prompt, at: Date()))
        listen(prompt: prompt, companion: companion)
    }

    func ask(_ prompt: String, companion: Companion) {
        guard !isReceiving else { return }
        messages.append(Message(role: .operatorSide, text: prompt, at: Date()))
        listen(prompt: prompt, companion: companion)
    }

    private func listen(prompt: String, companion: Companion) {
        buffer.begin()
        task?.cancel()
        task = Task { [service, buffer] in
            for await event in service.respond(to: prompt, companion: companion) {
                if Task.isCancelled { return }
                switch event {
                case let .delta(text):
                    // Consumed for liveness. Never rendered.
                    buffer.absorb(text)
                case let .final(text):
                    buffer.commit(final: text)
                case let .failed(message):
                    buffer.fail(message)
                }
            }
            if buffer.isReceiving {
                buffer.fail("The companion stopped answering before it committed a message.")
            }
            self.harvest()
        }
    }

    private func harvest() {
        if let text = buffer.revealedText {
            messages.append(Message(role: .companion, text: text, at: Date()))
            buffer.reset()
        }
    }

    /// Cancelling discards the uncommitted draft. Nothing half-said survives.
    func cancel() {
        task?.cancel()
        task = nil
        buffer.cancel()
    }

    func dismissFailure() {
        buffer.reset()
    }

    /// Back to an empty conversation, with nothing in flight.
    func reset() {
        task?.cancel()
        task = nil
        messages.removeAll()
        input = ""
        buffer.reset()
    }
}
