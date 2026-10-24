import AVFoundation

/// Spoken replies. No permission needed.
@MainActor
public final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var waiter: CheckedContinuation<Void, Never>?
    public var muted = false

    public override init() { super.init(); synth.delegate = self }

    public func speak(_ text: String) async {
        guard !muted, !text.isEmpty else { return }
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestEnglishVoice()
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            waiter = c
            synth.speak(u)
        }
    }

    public func stop() { synth.stopSpeaking(at: .immediate) }

    static func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return en.first { $0.quality == .premium } ?? en.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.waiter?.resume(); self.waiter = nil }
    }
    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.waiter?.resume(); self.waiter = nil }
    }
}
