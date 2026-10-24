import AVFoundation

/// Spoken replies. No permission needed.
@MainActor
public final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var waiter: CheckedContinuation<Void, Never>?
    private var current: AVSpeechUtterance?
    public var muted = false

    public override init() { super.init(); synth.delegate = self }

    /// Speaks and returns when the words are done (or cut off). A new speak cuts off the one before it and
    /// lets its caller go on, so no turn ever hangs waiting for words that were replaced.
    public func speak(_ text: String, slow: Bool = false) async {
        guard !muted, !text.isEmpty else { return }
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestEnglishVoice()
        u.rate = slow ? AVSpeechUtteranceDefaultSpeechRate * 0.7 : AVSpeechUtteranceDefaultSpeechRate
        release()
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        current = u
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            waiter = c
            synth.speak(u)
        }
    }

    public func stop() { release(); synth.stopSpeaking(at: .immediate) }

    private func release() { waiter?.resume(); waiter = nil; current = nil }

    static func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return en.first { $0.quality == .premium } ?? en.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in if u === self.current { self.release() } }
    }
    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in if u === self.current { self.release() } }
    }
}
