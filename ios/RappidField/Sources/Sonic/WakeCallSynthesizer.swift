import Foundation
import AVFoundation

/// Renders a companion's wake call from its own MIDI DNA.
///
/// Every sample is generated here from sine partials and an envelope. No
/// recording, sample library, or third-party sound is used or shipped: the
/// wake call is an original synthesis of the organism's own identity motif.
enum WakeCallSynthesizer {
    static let sampleRate: Double = 44_100

    /// The emergence cry plus the first half of the motif: a short glide into
    /// the call phrase, so the companion announces itself before it sings.
    static func renderSamples(signature: SonicSignature, sampleRate: Double = WakeCallSynthesizer.sampleRate) -> [Float] {
        let params = signature.parameters
        let notes = Array(signature.prompt.prefix(8))
        let onsets = MidiDNA.absoluteOnsets(signature.prompt)
        let cryDuration = 0.42
        let secondsPerTick = 60.0 / (Double(params.bpm) * Double(MidiDNA.ppq))
        let motifSeconds = Double(onsets[min(7, onsets.count - 1)] + (notes.last?.duration ?? MidiDNA.step)) * secondsPerTick
        let tailSeconds = 0.35
        let total = cryDuration + motifSeconds + tailSeconds
        var samples = [Float](repeating: 0, count: Int(total * sampleRate))

        // Emergence cry: a rising glide toward the motif's root, coloured by
        // the voice the identity chose.
        let cryFrames = Int(cryDuration * sampleRate)
        let rootFrequency = Tuning.frequency(midi: params.rootPitch + 12)
        var cryPhase = 0.0
        for frame in 0..<cryFrames {
            let progress = Double(frame) / Double(cryFrames)
            let frequency = rootFrequency * (0.45 + 0.55 * pow(progress, 0.6))
            cryPhase += 2 * .pi * frequency / sampleRate
            let envelope = sin(.pi * progress) * 0.45
            let shimmer = 0.22 * sin(cryPhase * 2.005)
            samples[frame] += Float(envelope * (sin(cryPhase) + shimmer))
        }

        for (index, note) in notes.enumerated() {
            let start = cryDuration + Double(onsets[index]) * secondsPerTick
            let duration = Double(note.duration) * secondsPerTick * 1.35
            let frequency = Tuning.frequency(midi: note.pitch)
            let amplitude = Double(note.velocity) / 127.0 * 0.5
            let startFrame = Int(start * sampleRate)
            let frameCount = Int(duration * sampleRate)
            guard startFrame >= 0 else { continue }
            for frame in 0..<frameCount {
                let position = startFrame + frame
                guard position < samples.count else { break }
                let progress = Double(frame) / Double(max(frameCount, 1))
                let attack = 1 - exp(-28 * progress)
                let decay = exp(-2.6 * progress)
                let envelope = amplitude * attack * decay
                let phase = 2 * .pi * frequency * Double(frame) / sampleRate
                let partials = sin(phase)
                    + 0.30 * sin(2 * phase)
                    + 0.14 * sin(3 * phase)
                    + 0.06 * sin(5 * phase)
                samples[position] += Float(envelope * partials * 0.55)
            }
        }

        var peak: Float = 0
        for sample in samples { peak = max(peak, abs(sample)) }
        guard peak > 0 else { return samples }
        let gain = 0.86 / peak
        return samples.map { $0 * gain }
    }

    static func buffer(signature: SonicSignature) -> AVAudioPCMBuffer? {
        let samples = renderSamples(signature: signature)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else {
            return nil
        }
        for (index, sample) in samples.enumerated() {
            channel[index] = sample
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }
}
