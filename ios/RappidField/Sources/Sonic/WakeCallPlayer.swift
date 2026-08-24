import Foundation
import AVFoundation
import Observation

/// Plays a companion's wake call, and only ever on an explicit gesture.
///
/// The engine is built on demand and torn down on stop, so a backgrounded app
/// holds no audio session. Failures are surfaced in the UI rather than
/// swallowed: a companion that cannot be heard is a fact the operator needs.
@MainActor
@Observable
final class WakeCallPlayer {
    enum State: Equatable {
        case idle
        case playing(RappidIdentity)
        case failed(String)
    }

    private(set) var state: State = .idle

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?

    var isPlaying: Bool {
        if case .playing = state { return true }
        return false
    }

    func isPlaying(_ identity: RappidIdentity) -> Bool {
        state == .playing(identity)
    }

    var failureMessage: String? {
        if case let .failed(message) = state { return message }
        return nil
    }

    /// Called only from a Play control. Nothing in this app calls it on appear.
    func play(signature: SonicSignature) {
        precondition(PlaybackPolicy.autoplayEverAllowed == false)
        stop()
        guard let buffer = WakeCallSynthesizer.buffer(signature: signature) else {
            state = .failed("Could not render the wake call on this device.")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true, options: [])

            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
            try engine.start()

            let identity = signature.rappid
            player.scheduleBuffer(buffer, at: nil, options: []) { [weak self] in
                Task { @MainActor in
                    guard let self, self.state == .playing(identity) else { return }
                    self.stop()
                }
            }
            player.play()

            self.engine = engine
            self.player = player
            state = .playing(identity)
        } catch {
            teardown()
            state = .failed("Audio unavailable: \(error.localizedDescription)")
        }
    }

    func stop() {
        teardown()
        if case .failed = state { return }
        state = .idle
    }

    private func teardown() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
