import Foundation

/// The on-device proposal provider.
///
/// It is a deterministic candidate generator and scorer, not a trained model,
/// and it says so in every proposal it produces. Nothing it returns is
/// organism state: a proposal becomes state only after an operator approves it
/// and a host appends and verifies a body frame.
enum ProposalEngine {
    static let candidateDimensions = ["memory", "skill", "visual", "device", "sonic"]

    static func propose(
        for companion: Companion,
        leash: SelfSteerLeash,
        progress: GameProgress = .initial
    ) -> GrowthProposal? {
        guard GrowthLeashPolicy.mayPropose(leash: leash) else { return nil }
        return proposal(for: companion, progress: progress)
    }

    /// Deterministic for a given organism, frame height and play progress, so
    /// two readings of the same state never disagree about what was proposed —
    /// and a companion you have actually played with reads differently from one
    /// you have not.
    static func proposal(for companion: Companion, progress: GameProgress = .initial) -> GrowthProposal {
        let seedBody = CanonicalJSON.render(.object([
            "rappid": .string(companion.identity.description),
            "frame_height": .int(companion.frameHeight),
            "attunement": .int(progress.attunement),
            "encounters_resolved": .int(progress.encountersResolved),
            "drills_completed": .int(progress.drillsCompleted),
            "purpose": .string("growth-proposal"),
        ]))
        let seed = Digest.sha256Hex(seedBody)
        var stream = DeterministicStream(seed: seed)

        let active = Set(companion.dimensions.filter { $0.status == .active }.map(\.name))
        let openDimensions = candidateDimensions.filter { !active.contains($0) }
        let dimension = openDimensions.isEmpty
            ? candidateDimensions[stream.nextBelow(candidateDimensions.count)]
            : openDimensions[stream.nextBelow(openDimensions.count)]

        let predictedFrameHeight = companion.frameHeight + 1
        let predictedBytes = 1_024 + stream.nextBelow(48) * 512 + progress.attunement * 64
        let currentHeight = companion.stats.displayHeightMillimetres
        let predictedHeight = companion.curve.millimetres(frameHeight: predictedFrameHeight)
        let predictedStage = MoltStage.derived(fromFrameHeight: predictedFrameHeight)

        let signature = SonicSignature(rappid: companion.identity, birthTraitsMilli: companion.birthTraitsMilli)

        return GrowthProposal(
            id: "proposal-" + String(Digest.sha256Hex("\(seed):\(dimension)").prefix(16)),
            rappid: companion.identity,
            dimension: dimension,
            title: title(for: dimension, path: companion.path),
            summary: summary(for: dimension, companion: companion, bytes: predictedBytes),
            provider: .localDeterministic,
            predictedFrameHeight: predictedFrameHeight,
            predictedStatDelta: [
                "frameHeight": predictedFrameHeight - companion.frameHeight,
                "weightBytes": predictedBytes,
                "displayHeightMm": predictedHeight - currentHeight,
            ],
            predictedStage: predictedStage,
            predictedDisplayHeightMillimetres: predictedHeight,
            evidence: [
                "Identity motif reproduced on device: \(signature.midiBytes) B, sha256 \(String(signature.midiSha256.prefix(16)))…",
                "Accepted frame depth read as \(companion.frameHeight); the proposal would make it \(predictedFrameHeight).",
                "Existing \(companion.dimensions.count) dimension families were read; \(dimension) is the one this reading reaches for.",
                "Field play read as attunement \(progress.attunement), \(progress.encountersResolved) encounters resolved, \(progress.drillsCompleted) drills completed.",
                "Provider is \(ProviderClaim.localDeterministic.kind); no trained model produced this.",
            ],
            proposedAssets: [],
            origin: companion.origin
        )
    }

    private static func title(for dimension: String, path: StarterPath) -> String {
        switch dimension {
        case "memory": return "Extend the memory cursor"
        case "skill": return "Record a skill dimension"
        case "visual": return "Project a visual dimension"
        case "device": return "Declare a device habitat"
        case "sonic": return "Append a sonic continuation"
        default: return "Append a \(dimension) dimension"
        }
    }

    private static func summary(for dimension: String, companion: Companion, bytes: Int) -> String {
        """
        A reading of \(companion.displayName)'s current frames suggests a \(dimension) \
        dimension is the next thing it could carry, at roughly \(Formatting.exactBytes(bytes)) \
        of new verified content. This is a proposal. It is not what your companion is, \
        and nothing changes until you approve it and a host appends the frame.
        """
    }
}
