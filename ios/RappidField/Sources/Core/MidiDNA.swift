import Foundation

/// `NOTE(pitch, delta_onset, duration, velocity)` — the whole note event.
struct Note: Equatable, Codable {
    let pitch: Int
    let deltaOnset: Int
    let duration: Int
    let velocity: Int
}

struct MusicalParameters: Equatable, Codable {
    let rootPitch: Int
    let rootPitchClass: Int
    let mode: String
    let scale: [Int]
    let bpm: Int
    let program: Int
}

/// MIDI DNA: the stable identity motif, and the bytes it renders to.
///
/// Everything here is a pure function of the RAPPID and the organism's birth
/// traits, so the same companion produces the same 16-note prompt on any
/// device, offline, forever — and *only* the prompt. Identity is never derived
/// from the motif; the motif is derived from the identity.
///
/// This is a port of the OpenRappter host derivation. It is byte-exact against
/// the host: `Tools/generate-parity-vectors.mjs` renders the same vectors from
/// the host runtime and `SonicIdentityTests` pins them.
enum MidiDNA {
    static let ppq = 480
    static let step = 120

    struct Mode {
        let name: String
        let scale: [Int]
    }

    static let modes: [Mode] = [
        Mode(name: "ionian", scale: [0, 2, 4, 5, 7, 9, 11]),
        Mode(name: "dorian", scale: [0, 2, 3, 5, 7, 9, 10]),
        Mode(name: "lydian", scale: [0, 2, 4, 6, 7, 9, 11]),
        Mode(name: "mixolydian", scale: [0, 2, 4, 5, 7, 9, 10]),
        Mode(name: "major-pentatonic", scale: [0, 2, 4, 7, 9]),
    ]

    static let programs = [4, 11, 80, 81, 89]
    private static let coreDegrees = [0, 2, 4, 1, 3, 5, 4, 2]
    private static let onsetChoices = [step * 2, step * 2, step * 3, step * 4]
    private static let durationChoices = [step * 2, step * 3, step * 4]

    static func clampInt(_ value: Int, _ low: Int, _ high: Int) -> Int {
        max(low, min(high, value))
    }

    /// The nearest pitch in the mode, ties broken downward so it is total.
    static func nearestScalePitch(_ value: Int, root: Int, scale: [Int]) -> Int {
        var best = root
        var bestDistance = Int.max
        for octave in -1..<4 {
            for degree in scale {
                let pitch = root + octave * 12 + degree
                let distance = abs(pitch - value)
                if distance < bestDistance || (distance == bestDistance && pitch < best) {
                    best = pitch
                    bestDistance = distance
                }
            }
        }
        return best
    }

    private static func seedValue(
        rappid: String,
        birthTraitsMilli: [String: Int],
        purpose: String
    ) -> CanonicalJSON.Value {
        var traits: [String: CanonicalJSON.Value] = [:]
        for (key, value) in birthTraitsMilli {
            traits[key] = .int(value)
        }
        return .object([
            "rappid": .string(rappid),
            "birth_traits_milli": .object(traits),
            "purpose": .string(purpose),
        ])
    }

    /// Key, tempo and voice, frozen from identity plus the birth trait snapshot.
    static func parameters(rappid: String, birthTraitsMilli: [String: Int]) -> MusicalParameters {
        let seed = Digest.sha256Hex(
            CanonicalJSON.render(seedValue(rappid: rappid, birthTraitsMilli: birthTraitsMilli, purpose: "parameters"))
        )
        var stream = DeterministicStream(seed: seed)
        let rootPitchClass = stream.nextBelow(12)
        let mode = modes[stream.nextBelow(modes.count)]
        // Draw order is part of the contract: octave, then tempo, then voice.
        let rootPitch = stream.nextBelow(2) == 0 ? 48 + rootPitchClass : 60 + rootPitchClass
        let bpm = 96 + stream.nextBelow(25)
        let program = programs[stream.nextBelow(programs.count)]
        return MusicalParameters(
            rootPitch: rootPitch,
            rootPitchClass: rootPitchClass,
            mode: mode.name,
            scale: mode.scale,
            bpm: bpm,
            program: program
        )
    }

    /// The 16-note identity motif: an 8-note call and a birth-frozen response.
    ///
    /// The response is the call reversed and then bent by the traits that have
    /// a musical meaning, so a curious companion answers itself with wider
    /// colour while a continuity-bound one answers itself almost literally.
    static func dnaPrompt(
        rappid: String,
        birthTraitsMilli: [String: Int],
        parameters params: MusicalParameters
    ) -> [Note] {
        let identity = Array(Digest.sha256(Data(
            CanonicalJSON.render(seedValue(rappid: rappid, birthTraitsMilli: birthTraitsMilli, purpose: "midi-dna")).utf8
        )))
        let degrees = coreDegrees.enumerated().map { index, degree in
            clampInt(degree + (Int(identity[index]) % 3 - 1), 0, params.scale.count - 1)
        }
        let contour = degrees.map { params.rootPitch + 12 + params.scale[$0] }
        let response = contour.reversed().enumerated().map { index, pitch -> Int in
            let octaveEcho = (index == 1 || index == 5) && (identity[index] & 0x1) != 0 ? 12 : 0
            let colour = (index == 3 || index == 7) && (identity[index] & 0x2) != 0 ? 2 : 0
            return nearestScalePitch(pitch + octaveEcho + colour, root: params.rootPitch, scale: params.scale)
        }

        return (contour + response).enumerated().map { index, pitch in
            var deltaOnset = index == 0 ? 0 : onsetChoices[Int(identity[16 + index]) % 4]
            if (index == 4 || index == 12) && (identity[8 + index] & 0x1) != 0 {
                deltaOnset = step
            }
            let velocity = 70 + (Int(identity[identity.count - 1 - index]) % 24)
            let accented = index == 0 || index == 8 || index == 15
            return Note(
                pitch: pitch,
                deltaOnset: deltaOnset,
                duration: durationChoices[Int(identity[index]) % 3],
                velocity: accented ? min(108, velocity + 10) : velocity
            )
        }
    }

    /// MIDI variable-length quantity.
    static func variableLength(_ value: Int) -> [UInt8] {
        precondition(value >= 0, "variable-length quantities are non-negative integers")
        var remaining = value
        var buffer = remaining & 0x7F
        var out: [UInt8] = []
        while remaining >> 7 != 0 {
            remaining >>= 7
            buffer <<= 8
            buffer |= (remaining & 0x7F) | 0x80
        }
        while true {
            out.append(UInt8(buffer & 0xFF))
            if buffer & 0x80 != 0 { buffer >>= 8 } else { break }
        }
        return out
    }

    private struct Span {
        var onset: Int
        var end: Int
        var pitch: Int
        var velocity: Int
        var channel: Int
    }

    /// A single-track SMF, byte-for-byte reproducible.
    ///
    /// The sub-octave doubling under notes 8 and 16 is inherited deliberately:
    /// the point of rendering locally is to land on the same bytes and the same
    /// content address the organism's sonic dimension already recorded, not to
    /// produce a second, subtly different rendering of the same motif.
    static func render(notes: [Note], parameters params: MusicalParameters) -> Data {
        precondition(!notes.isEmpty, "refusing to render a MIDI file with no notes")
        var spans: [Span] = []
        var onset = 0
        for (index, note) in notes.enumerated() {
            onset += note.deltaOnset
            spans.append(Span(onset: onset, end: onset + note.duration, pitch: note.pitch, velocity: note.velocity, channel: 0))
            if (index == 7 || index == 15) && index + 1 < notes.count {
                spans.append(Span(
                    onset: onset,
                    end: onset + note.duration,
                    pitch: clampInt(note.pitch - 12, 36, 96),
                    velocity: max(34, note.velocity - 28),
                    channel: 1
                ))
            }
        }

        for channel in [0, 1] {
            for pitch in 0..<128 {
                let matching = spans.indices
                    .filter { spans[$0].channel == channel && spans[$0].pitch == pitch }
                    .sorted { left, right in
                        spans[left].onset == spans[right].onset ? left < right : spans[left].onset < spans[right].onset
                    }
                for slot in 1..<max(matching.count, 1) {
                    let previous = matching[slot - 1]
                    let current = matching[slot]
                    if spans[previous].end >= spans[current].onset {
                        spans[previous].end = max(spans[previous].onset + 1, spans[current].onset - 1)
                    }
                }
            }
        }

        struct Event {
            let tick: Int
            let kind: Int
            let order: Int
            let payload: [UInt8]
        }
        var events: [Event] = []
        for span in spans {
            events.append(Event(tick: span.onset, kind: 1, order: events.count,
                                payload: [UInt8(0x90 | span.channel), UInt8(span.pitch), UInt8(span.velocity)]))
            events.append(Event(tick: span.end, kind: 0, order: events.count,
                                payload: [UInt8(0x80 | span.channel), UInt8(span.pitch), 0]))
        }
        // Stable ordering: the host sorts with a stable sort, Swift's is not.
        events.sort { left, right in
            if left.tick != right.tick { return left.tick < right.tick }
            if left.kind != right.kind { return left.kind < right.kind }
            return left.order < right.order
        }

        let tempo = roundHalfUp(60_000_000.0 / Double(params.bpm))
        var track: [UInt8] = []
        let trackName = Array("Quantum RAPPID".utf8)
        track += [0x00, 0xFF, 0x03, UInt8(trackName.count)]
        track += trackName
        track += [0x00, 0xFF, 0x51, 0x03,
                  UInt8((tempo >> 16) & 0xFF), UInt8((tempo >> 8) & 0xFF), UInt8(tempo & 0xFF)]
        track += [0x00, 0xC0, UInt8(params.program)]
        track += [0x00, 0xC1, UInt8(params.program)]
        var current = 0
        for event in events {
            track += variableLength(event.tick - current)
            track += event.payload
            current = event.tick
        }
        track += [0x00, 0xFF, 0x2F, 0x00]

        var out = Data()
        out.append(contentsOf: Array("MThd".utf8))
        out.append(contentsOf: bigEndian32(6))
        out.append(contentsOf: bigEndian16(0))
        out.append(contentsOf: bigEndian16(1))
        out.append(contentsOf: bigEndian16(ppq))
        out.append(contentsOf: Array("MTrk".utf8))
        out.append(contentsOf: bigEndian32(track.count))
        out.append(contentsOf: track)
        return out
    }

    private static func bigEndian16(_ value: Int) -> [UInt8] {
        [UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)]
    }

    private static func bigEndian32(_ value: Int) -> [UInt8] {
        [UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF),
         UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)]
    }

    /// Total ticks a note list occupies, for playback without rendering it.
    static func durationTicks(_ notes: [Note]) -> Int {
        var onset = 0
        var end = 0
        for note in notes {
            onset += note.deltaOnset
            end = max(end, onset + note.duration)
        }
        return end
    }

    /// Ticks to whole milliseconds, so playback timing stays integer.
    static func ticksToMilliseconds(_ ticks: Int, bpm: Int) -> Int {
        idiv(ticks * 60_000, bpm * ppq)
    }

    static func absoluteOnsets(_ notes: [Note]) -> [Int] {
        var onset = 0
        return notes.map { note in
            onset += note.deltaOnset
            return onset
        }
    }
}
