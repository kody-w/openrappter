import XCTest
@testable import RappidField

/// The sonic identity is the whole visual identity, so "deterministic" has to
/// mean byte-exact — and exact against the host runtime, not merely against
/// this port. The vectors below were produced by the OpenRappter host
/// implementation via `Tools/generate-parity-vectors.mjs`.
final class SonicIdentityTests: XCTestCase {
    struct Vector {
        let path: StarterPath
        let rootPitch: Int
        let rootPitchClass: Int
        let mode: String
        let bpm: Int
        let program: Int
        let midiBytes: Int
        let midiSha256: String
        let notes: [[Int]]
    }

    static let vectors: [Vector] = [
        .init(
            path: .canopy,
            rootPitch: 57, rootPitchClass: 9, mode: "mixolydian", bpm: 110, program: 89,
            midiBytes: 207,
            midiSha256: "7907343650f92b1271224e41a3f62963e3d2d6ee022b0d58d54cecd4a57eb572",
            notes: [[71, 0, 480, 97], [74, 240, 480, 73], [76, 240, 360, 77], [73, 480, 480, 90],
                    [73, 120, 240, 82], [76, 240, 240, 79], [76, 240, 360, 77], [73, 360, 360, 77],
                    [73, 480, 480, 94], [88, 480, 360, 87], [76, 240, 360, 90], [73, 240, 480, 82],
                    [73, 240, 240, 73], [76, 480, 480, 79], [74, 480, 480, 83], [73, 240, 360, 100]]
        ),
        .init(
            path: .current,
            rootPitch: 53, rootPitchClass: 5, mode: "lydian", bpm: 119, program: 81,
            midiBytes: 207,
            midiSha256: "03cc445bce8769a5166ee1c7af8fb8731914b50ede28045dced2af0d7d0c53a9",
            notes: [[65, 0, 360, 90], [71, 360, 480, 86], [74, 480, 480, 79], [67, 240, 360, 81],
                    [71, 480, 360, 77], [76, 240, 480, 80], [74, 240, 480, 93], [67, 240, 240, 90],
                    [67, 240, 360, 81], [74, 480, 240, 87], [76, 360, 240, 86], [71, 480, 480, 77],
                    [67, 120, 480, 70], [74, 240, 360, 93], [71, 240, 360, 80], [67, 360, 240, 87]]
        ),
        .init(
            path: .forge,
            rootPitch: 69, rootPitchClass: 9, mode: "major-pentatonic", bpm: 105, program: 80,
            midiBytes: 212,
            midiSha256: "d7146eb1e13e261997aa337e0bda38f0c711980095d2937d4e9ce4dbdf02a73f",
            notes: [[83, 0, 480, 103], [88, 240, 480, 70], [90, 480, 480, 92], [81, 480, 240, 93],
                    [85, 480, 240, 70], [90, 480, 360, 71], [90, 240, 480, 78], [83, 240, 240, 81],
                    [83, 480, 480, 96], [102, 240, 360, 82], [90, 240, 360, 89], [88, 240, 240, 81],
                    [81, 120, 360, 85], [90, 360, 480, 81], [88, 240, 240, 70], [83, 480, 360, 96]]
        ),
    ]

    func testMotifMatchesHostRuntimeExactly() {
        for vector in Self.vectors {
            let identity = SyntheticField.identity(for: vector.path)
            let params = MidiDNA.parameters(
                rappid: identity.description,
                birthTraitsMilli: vector.path.birthTraitsMilli
            )
            XCTAssertEqual(params.rootPitch, vector.rootPitch, "\(vector.path) root pitch")
            XCTAssertEqual(params.rootPitchClass, vector.rootPitchClass, "\(vector.path) root pitch class")
            XCTAssertEqual(params.mode, vector.mode, "\(vector.path) mode")
            XCTAssertEqual(params.bpm, vector.bpm, "\(vector.path) bpm")
            XCTAssertEqual(params.program, vector.program, "\(vector.path) program")

            let prompt = MidiDNA.dnaPrompt(
                rappid: identity.description,
                birthTraitsMilli: vector.path.birthTraitsMilli,
                parameters: params
            )
            XCTAssertEqual(prompt.count, 16)
            for (index, expected) in vector.notes.enumerated() {
                XCTAssertEqual(prompt[index].pitch, expected[0], "\(vector.path) note \(index) pitch")
                XCTAssertEqual(prompt[index].deltaOnset, expected[1], "\(vector.path) note \(index) onset")
                XCTAssertEqual(prompt[index].duration, expected[2], "\(vector.path) note \(index) duration")
                XCTAssertEqual(prompt[index].velocity, expected[3], "\(vector.path) note \(index) velocity")
            }
        }
    }

    func testRenderedMidiIsByteIdenticalToTheHost() {
        for vector in Self.vectors {
            let signature = SyntheticField.signature(for: vector.path)
            XCTAssertEqual(signature.midiBytes, vector.midiBytes, "\(vector.path) rendered MIDI byte count")
            XCTAssertEqual(signature.midiSha256, vector.midiSha256, "\(vector.path) rendered MIDI content address")
        }
    }

    func testSignatureIsStableAcrossRepeatedDerivation() {
        for path in StarterPath.allCases {
            let first = SyntheticField.signature(for: path)
            let second = SonicSignature(
                rappid: SyntheticField.identity(for: path),
                birthTraitsMilli: path.birthTraitsMilli
            )
            XCTAssertEqual(first, second, "\(path) signature must be a pure function of identity and birth traits")
            XCTAssertEqual(first.waveform, second.waveform)
            XCTAssertEqual(first.rings, second.rings)
            XCTAssertEqual(first.roll, second.roll)
        }
    }

    func testEachPathSoundsDifferent() {
        let signatures = StarterPath.allCases.map { SyntheticField.signature(for: $0) }
        let addresses = Set(signatures.map(\.midiSha256))
        XCTAssertEqual(addresses.count, StarterPath.allCases.count, "different starters must not share a motif")
        XCTAssertEqual(Set(signatures.map(\.parameters.mode)).count, 3)
    }

    func testMotifIsDerivedFromIdentityAndNotTheOtherWayAround() {
        // Present traits drift; the motif is conditioned on the birth snapshot,
        // so a drifted organism still answers with the same identity motif.
        let path = StarterPath.forge
        let identity = SyntheticField.identity(for: path)
        let drifted = SyntheticField.traitsMilli(for: path)
        XCTAssertNotEqual(drifted, path.birthTraitsMilli, "fixture should exercise trait drift")

        let fromBirth = SonicSignature(rappid: identity, birthTraitsMilli: path.birthTraitsMilli)
        let companion = SyntheticField.companion(for: path)
        let fromCompanion = SonicSignature(rappid: companion.identity, birthTraitsMilli: companion.birthTraitsMilli)
        XCTAssertEqual(fromBirth, fromCompanion)
    }

    func testWakeCallIsSynthesisedNotShipped() {
        let signature = SyntheticField.signature(for: .current)
        let samples = WakeCallSynthesizer.renderSamples(signature: signature)
        XCTAssertGreaterThan(samples.count, Int(WakeCallSynthesizer.sampleRate) / 2)
        XCTAssertLessThanOrEqual(samples.map(abs).max() ?? 0, 1.0, "the render must not clip")
        XCTAssertEqual(samples, WakeCallSynthesizer.renderSamples(signature: signature), "synthesis must be deterministic")
        XCTAssertFalse(PlaybackPolicy.autoplayEverAllowed, "nothing in this app may autoplay")
        XCTAssertTrue(PlaybackPolicy.default.requiresUserGesture)
        XCTAssertTrue(PlaybackPolicy.default.stopControlRequired)
    }

    func testDeterministicStreamMatchesTheSharedContract() {
        // block_n = sha256("<seed>:<n>"), consumed a byte at a time.
        var stream = DeterministicStream(seed: "seed")
        let expected = Digest.sha256(Data("seed:0".utf8))
        var reproduced: [UInt8] = []
        for _ in 0..<8 {
            reproduced.append(contentsOf: withUnsafeBytes(of: stream.nextUInt32().bigEndian) { Array($0) })
        }
        XCTAssertEqual(Array(expected.prefix(32)), reproduced)
    }

    func testCanonicalJSONSortsKeysAndEscapesToASCII() {
        let rendered = CanonicalJSON.render(.object([
            "b": .int(2),
            "a": .string("é\n"),
        ]))
        XCTAssertEqual(rendered, "{\"a\":\"\\u00e9\\n\",\"b\":2}")
    }
}
