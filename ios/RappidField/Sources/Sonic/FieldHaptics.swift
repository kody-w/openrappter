import Foundation
import CoreHaptics
import Observation

/// A short haptic pulse shaped by the companion's own motif.
///
/// The simulator reports no haptic hardware, so this reports unavailable
/// instead of failing: the UI says so rather than pretending it buzzed.
@MainActor
@Observable
final class FieldHaptics {
    private(set) var isSupported: Bool
    private(set) var lastError: String?
    private var engine: CHHapticEngine?

    init() {
        isSupported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    }

    var availabilityNote: String {
        isSupported
            ? "Haptics follow the first four notes of the motif."
            : "No haptic hardware here, so the wake call is sound only."
    }

    /// Taps the first few notes of the motif. Gesture-driven, like playback.
    func pulse(for signature: SonicSignature) {
        guard isSupported else { return }
        do {
            let engine = try currentEngine()
            let onsets = MidiDNA.absoluteOnsets(signature.prompt)
            let secondsPerTick = 60.0 / (Double(signature.parameters.bpm) * Double(MidiDNA.ppq))
            let events = signature.prompt.prefix(4).enumerated().map { index, note in
                CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(note.velocity) / 127.0),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(note.pitch % 12) / 12.0),
                    ],
                    relativeTime: Double(onsets[index]) * secondsPerTick
                )
            }
            let pattern = try CHHapticPattern(events: Array(events), parameters: [])
            try engine.makePlayer(with: pattern).start(atTime: CHHapticTimeImmediate)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stop() {
        engine?.stop(completionHandler: nil)
        engine = nil
    }

    private func currentEngine() throws -> CHHapticEngine {
        if let engine { return engine }
        let created = try CHHapticEngine()
        created.resetHandler = { [weak created] in try? created?.start() }
        try created.start()
        engine = created
        return created
    }
}
