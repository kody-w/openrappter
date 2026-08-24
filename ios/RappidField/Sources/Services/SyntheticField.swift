import Foundation

/// Deterministic sample companions, used whenever no host is paired.
///
/// These are fixtures, and every screen that shows one says so. What is *not*
/// faked: the sonic assets are rendered on device from the fixture's own
/// identity, so their byte counts and content addresses are exact and
/// verifiable rather than decorative numbers.
enum SyntheticField {
    static let fixtureDomain = "rappid-field/fixture/1"

    static func identity(for path: StarterPath) -> RappidIdentity {
        // A fixture identity is minted once, from a fixed label, so the same
        // sample organism appears on every device and every run.
        let hex = Digest.sha256Hex("\(fixtureDomain):\(path.rawValue)")
        return try! RappidIdentity(owner: "field", name: "\(path.rawValue)-companion", hex: hex)
    }

    static func displayName(for path: StarterPath) -> String {
        switch path {
        case .canopy: return "Mossline"
        case .current: return "Tidewalk"
        case .forge: return "Emberline"
        }
    }

    static func frameHeight(for path: StarterPath) -> Int {
        switch path {
        case .canopy: return 9
        case .current: return 14
        case .forge: return 21
        }
    }

    static func signature(for path: StarterPath) -> SonicSignature {
        SonicSignature(rappid: identity(for: path), birthTraitsMilli: path.birthTraitsMilli)
    }

    /// The rendered wake call, as the bytes an organism would carry.
    static func wakeCallData(for signature: SonicSignature) -> Data {
        let samples = WakeCallSynthesizer.renderSamples(signature: signature)
        var data = Data(capacity: samples.count * 4)
        for sample in samples {
            withUnsafeBytes(of: sample.bitPattern.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    static func midiData(for signature: SonicSignature) -> Data {
        MidiDNA.render(notes: signature.prompt, parameters: signature.parameters)
    }

    static func assets(for path: StarterPath) -> [CarriedAsset] {
        let signature = signature(for: path)
        let midi = midiData(for: signature)
        let wake = wakeCallData(for: signature)
        let midiAddress = ContentAddress(space: "rapp/1:egg", hash: Digest.sha256Hex(midi))

        var assets: [CarriedAsset] = [
            CarriedAsset(
                dimension: "sonic",
                path: "assets/dna-prompt.mid",
                address: midiAddress,
                bytes: midi.count,
                mediaType: "audio/midi",
                resident: true,
                verified: true
            ),
            CarriedAsset(
                dimension: "sonic",
                path: "assets/wake-call.pcm",
                address: ContentAddress(space: "rapp/1:egg", hash: Digest.sha256Hex(wake)),
                bytes: wake.count,
                mediaType: "audio/x-pcm-f32le",
                resident: true,
                verified: true
            ),
            CarriedAsset(
                dimension: "memory",
                path: "engram-cursor.json",
                address: ContentAddress(space: "rapp/1:egg", hash: Digest.sha256Hex("\(fixtureDomain):memory:\(path.rawValue)")),
                bytes: 2_048 + frameHeight(for: path) * 64,
                mediaType: "application/json",
                resident: true,
                verified: true
            ),
        ]

        switch path {
        case .canopy:
            // The same content address the sonic dimension already carries.
            // A duplicate cannot make an organism heavier, and the Field Guide
            // shows it being counted once.
            assets.append(CarriedAsset(
                dimension: "visual",
                path: "motif-mirror.mid",
                address: midiAddress,
                bytes: midi.count,
                mediaType: "audio/midi",
                resident: true,
                verified: true
            ))
        case .current:
            assets.append(CarriedAsset(
                dimension: "skill",
                path: "skills/field-notes.md",
                address: ContentAddress(space: "rapp/1:egg", hash: Digest.sha256Hex("\(fixtureDomain):skill:current")),
                bytes: 7_311,
                mediaType: "text/markdown",
                resident: false,
                verified: true
            ))
        case .forge:
            // A referenced dimension whose size this habitat has never seen.
            // It is carried as unknown, which makes the weight incomplete.
            assets.append(CarriedAsset(
                dimension: "device",
                path: "habitat/link-manifest.json",
                address: ContentAddress(space: "rapp/1:egg", hash: Digest.sha256Hex("\(fixtureDomain):device:forge")),
                bytes: nil,
                mediaType: "application/json",
                resident: false,
                verified: false
            ))
        }
        return assets
    }

    static func dimensions(for path: StarterPath) -> [DimensionRecord] {
        var records = [
            DimensionRecord(name: "sonic", status: .active, mediaTypes: ["audio/midi", "audio/x-pcm-f32le"]),
            DimensionRecord(name: "memory", status: .active, mediaTypes: ["application/json"]),
        ]
        switch path {
        case .canopy:
            records.append(DimensionRecord(name: "visual", status: .active, mediaTypes: ["audio/midi"]))
        case .current:
            records.append(DimensionRecord(name: "skill", status: .linked, mediaTypes: ["text/markdown"]))
        case .forge:
            records.append(DimensionRecord(name: "skill", status: .active, mediaTypes: ["text/markdown"]))
            records.append(DimensionRecord(name: "device", status: .linked, mediaTypes: ["application/json"]))
        }
        return records
    }

    static func traitsMilli(for path: StarterPath) -> [String: Int] {
        // Present traits drift from the birth snapshot; the birth snapshot is
        // what identity and the motif were conditioned on and never moves.
        let drift: [StarterPath: [String: Int]] = [
            .canopy: ["continuity": 40, "curiosity": 25],
            .current: ["resonance": 55, "autonomy": 20],
            .forge: ["autonomy": 60, "safety": 30],
        ]
        var traits = path.birthTraitsMilli
        for (key, delta) in drift[path] ?? [:] {
            traits[key] = min(1000, (traits[key] ?? 0) + delta)
        }
        return traits
    }

    static func companion(for path: StarterPath) -> Companion {
        let height = frameHeight(for: path)
        return Companion(
            identity: identity(for: path),
            path: path,
            displayName: displayName(for: path),
            stage: MoltStage.derived(fromFrameHeight: height),
            traitsMilli: traitsMilli(for: path),
            birthTraitsMilli: path.birthTraitsMilli,
            dimensions: dimensions(for: path),
            assets: assets(for: path),
            frameHeight: height,
            uniqueFrames: height,
            origin: .syntheticFixture,
            localOnly: true,
            verified: true
        )
    }

    static var roster: [Companion] {
        StarterPath.allCases.map { companion(for: $0) }
    }
}
