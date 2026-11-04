import AVFoundation

/// Spoken replies. No permission needed.
@MainActor
public final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    private var synth: AVSpeechSynthesizer?
    private let output: (AVSpeechUtterance) -> Void
    private let stopOutput: () -> Void
    private var waiters: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]
    private var current: ObjectIdentifier?
    public var muted = false

    public init(output: ((AVSpeechUtterance) -> Void)? = nil, stop: (() -> Void)? = nil) {
        if let output, let stop {
            self.output = output; stopOutput = stop
        } else {
            let synth = AVSpeechSynthesizer()
            self.synth = synth
            self.output = { synth.speak($0) }
            stopOutput = { synth.stopSpeaking(at: .immediate) }
        }
        super.init()
        synth?.delegate = self
    }

    public func speak(_ text: String) async {
        guard !muted, !text.isEmpty else { return }
        stop()
        let u = AVSpeechUtterance(string: OwnerWords.plain(text))
        if synth != nil { u.voice = Self.bestEnglishVoice() }
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        let id = ObjectIdentifier(u)
        await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                guard !Task.isCancelled else { c.resume(); return }
                waiters[id] = c; current = id
                output(u)
            }
        } onCancel: {
            Task { @MainActor in
                if self.current == id { self.stop() } else { self.complete(id) }
            }
        }
    }

    public func stop() {
        stopOutput()
        current = nil
        let pending = waiters.values
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    func complete(_ id: ObjectIdentifier) {
        if current == id { current = nil }
        waiters.removeValue(forKey: id)?.resume()
    }

    static func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return en.first { $0.quality == .premium } ?? en.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.complete(ObjectIdentifier(u)) }
    }
    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.complete(ObjectIdentifier(u)) }
    }
}
