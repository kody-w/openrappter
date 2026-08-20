import Foundation

/// One note, placed on the identity ring.
struct SonicRing: Equatable {
    let index: Int
    /// 0...1, low pitch at the centre.
    let radius: Double
    /// Radians. Where in the motif this note lands.
    let phase: Double
    /// 0...1, from velocity.
    let weight: Double
    let pitchClass: Int
    /// 0...1, how long the note is held.
    let sustain: Double
}

/// One note, placed on the piano roll.
struct SonicRollCell: Equatable {
    let index: Int
    /// 0...1 of the motif's total length.
    let start: Double
    let width: Double
    /// 0...1 within the motif's own pitch span.
    let pitch: Double
    let velocity: Double
    let isCall: Bool
}

/// The visual identity of a companion, derived only from its MIDI DNA.
///
/// There is no 3D model and no character art anywhere in this app. What you
/// see is what the organism sounds like, drawn: the same 16 notes as rings, a
/// piano roll, and a rendered waveform. Same RAPPID and birth traits produce
/// the same picture on any device, offline, forever.
struct SonicSignature: Equatable {
    let rappid: RappidIdentity
    let parameters: MusicalParameters
    let prompt: [Note]
    let rings: [SonicRing]
    let roll: [SonicRollCell]
    /// A deterministic, low-rate render of the motif, for drawing only.
    let waveform: [Double]
    let durationMilliseconds: Int
    /// Exact bytes of the locally rendered `dna-prompt.mid`, and its address.
    let midiBytes: Int
    let midiSha256: String

    static let waveformSampleCount = 512

    init(rappid: RappidIdentity, birthTraitsMilli: [String: Int]) {
        let params = MidiDNA.parameters(rappid: rappid.description, birthTraitsMilli: birthTraitsMilli)
        let notes = MidiDNA.dnaPrompt(rappid: rappid.description, birthTraitsMilli: birthTraitsMilli, parameters: params)
        let midi = MidiDNA.render(notes: notes, parameters: params)

        self.rappid = rappid
        self.parameters = params
        self.prompt = notes
        self.midiBytes = midi.count
        self.midiSha256 = Digest.sha256Hex(midi)

        let totalTicks = max(MidiDNA.durationTicks(notes), 1)
        self.durationMilliseconds = MidiDNA.ticksToMilliseconds(totalTicks, bpm: params.bpm)

        let onsets = MidiDNA.absoluteOnsets(notes)
        let pitches = notes.map(\.pitch)
        let lowest = pitches.min() ?? params.rootPitch
        let highest = pitches.max() ?? (params.rootPitch + 12)
        let span = max(highest - lowest, 1)

        self.rings = notes.enumerated().map { index, note in
            SonicRing(
                index: index,
                radius: 0.24 + 0.72 * Double(note.pitch - lowest) / Double(span),
                phase: 2 * .pi * Double(onsets[index]) / Double(totalTicks),
                weight: Double(note.velocity - 60) / 48.0,
                pitchClass: note.pitch % 12,
                sustain: Double(note.duration) / Double(MidiDNA.step * 4)
            )
        }

        self.roll = notes.enumerated().map { index, note in
            SonicRollCell(
                index: index,
                start: Double(onsets[index]) / Double(totalTicks),
                width: Double(note.duration) / Double(totalTicks),
                pitch: Double(note.pitch - lowest) / Double(span),
                velocity: Double(note.velocity) / 108.0,
                isCall: index < 8
            )
        }

        self.waveform = Self.waveform(notes: notes, parameters: params, sampleCount: Self.waveformSampleCount)
    }

    /// A cheap additive render, purely for drawing. Integer-stable inputs, so
    /// two devices draw the same curve.
    static func waveform(notes: [Note], parameters params: MusicalParameters, sampleCount: Int) -> [Double] {
        precondition(sampleCount > 0, "a waveform needs samples")
        let onsets = MidiDNA.absoluteOnsets(notes)
        let total = Double(max(MidiDNA.durationTicks(notes), 1))
        var samples = [Double](repeating: 0, count: sampleCount)
        for (index, note) in notes.enumerated() {
            let start = Double(onsets[index]) / total
            let end = min(1.0, Double(onsets[index] + note.duration) / total)
            let frequency = Tuning.frequency(midi: note.pitch)
            let amplitude = Double(note.velocity) / 127.0
            let first = Int(start * Double(sampleCount))
            let last = min(sampleCount, Int(end * Double(sampleCount)))
            guard last > first else { continue }
            for sample in first..<last {
                let progress = Double(sample - first) / Double(max(last - first, 1))
                let envelope = exp(-3.2 * progress) * (1 - exp(-24 * progress))
                let phase = 2 * .pi * frequency * (Double(sample) / Double(sampleCount)) * 0.05
                samples[sample] += amplitude * envelope * (sin(phase) + 0.32 * sin(2 * phase))
            }
        }
        let peak = samples.map(abs).max() ?? 0
        guard peak > 0 else { return samples }
        return samples.map { $0 / peak }
    }
}

enum Tuning {
    /// Equal temperament, A440. Presentation and synthesis only.
    static func frequency(midi: Int) -> Double {
        440.0 * pow(2.0, (Double(midi) - 69.0) / 12.0)
    }
}

/// The organism's own statement about playback, carried rather than
/// second-guessed. Nothing in this app autoplays.
struct PlaybackPolicy: Equatable {
    let requiresUserGesture: Bool
    let stopControlRequired: Bool

    static let `default` = PlaybackPolicy(requiresUserGesture: true, stopControlRequired: true)

    /// A companion that says it must not sound without a user gesture must not
    /// be autoplayed by anything reading this.
    static let autoplayEverAllowed = false
}
