import Foundation

/// Where the data on screen came from. The UI never hides this.
enum DataOrigin: Equatable, Codable {
    /// Deterministic local fixtures. Verifiable, reproducible, and not real.
    case syntheticFixture
    /// A paired local OpenRappter host.
    case pairedHost(URL)

    var isSynthetic: Bool { self == .syntheticFixture }

    /// Appending body frames to a fixture would be theatre, so it is refused.
    var allowsAppend: Bool { !isSynthetic }

    var badge: String {
        switch self {
        case .syntheticFixture: return "SYNTHETIC"
        case .pairedHost: return "LINKED"
        }
    }

    var detail: String {
        switch self {
        case .syntheticFixture:
            return "Deterministic local sample. No host is paired, so nothing here is a verified organism."
        case let .pairedHost(url):
            return "Served by your paired host at \(url.absoluteString)."
        }
    }
}

enum DimensionStatus: String, Codable {
    case active
    case linked
    case missing

    var label: String {
        switch self {
        case .active: return "Active"
        case .linked: return "Linked"
        case .missing: return "Missing"
        }
    }
}

struct DimensionRecord: Hashable, Codable, Identifiable {
    let name: String
    let status: DimensionStatus
    let mediaTypes: [String]

    var id: String { name }
}

/// One canonical identity projected through many independently verifiable
/// dimensions. Molting rewrites none of it.
struct Companion: Identifiable, Equatable {
    let identity: RappidIdentity
    let path: StarterPath
    let displayName: String
    var stage: MoltStage
    var traitsMilli: [String: Int]
    var birthTraitsMilli: [String: Int]
    var dimensions: [DimensionRecord]
    var assets: [CarriedAsset]
    var frameHeight: Int
    var uniqueFrames: Int
    var curve: DisplayHeightCurve
    var origin: DataOrigin
    var localOnly: Bool
    var verified: Bool
    /// What the host called this organism, when a host said anything at all.
    var hostSpecies: String?
    /// True when the field path had to be inferred because the host reported a
    /// species this build has no rendering for. Always shown, never hidden.
    var pathInferred: Bool

    var id: String { identity.description }

    init(
        identity: RappidIdentity,
        path: StarterPath,
        displayName: String,
        stage: MoltStage,
        traitsMilli: [String: Int],
        birthTraitsMilli: [String: Int],
        dimensions: [DimensionRecord],
        assets: [CarriedAsset],
        frameHeight: Int,
        uniqueFrames: Int,
        curve: DisplayHeightCurve = .v1_2,
        origin: DataOrigin,
        localOnly: Bool,
        verified: Bool,
        hostSpecies: String? = nil,
        pathInferred: Bool = false
    ) {
        self.identity = identity
        self.path = path
        self.displayName = displayName
        self.stage = stage
        self.traitsMilli = traitsMilli
        self.birthTraitsMilli = birthTraitsMilli
        self.dimensions = dimensions
        self.assets = assets
        self.frameHeight = frameHeight
        self.uniqueFrames = uniqueFrames
        self.curve = curve
        self.origin = origin
        self.localOnly = localOnly
        self.verified = verified
        self.hostSpecies = hostSpecies
        self.pathInferred = pathInferred
    }

    var stats: CreatureStats {
        CreatureStats(
            frameHeight: frameHeight,
            uniqueFrames: uniqueFrames,
            weight: WeightLedger(assets: assets),
            curve: curve
        )
    }

    var moltName: String { path.moltName(for: stage) }

    var moltSummary: String { MoltDescription.summary(for: stage, path: path) }

    var linkStatusLabel: String {
        localOnly ? "Local only" : "Linked to host"
    }

    /// A molt is a projection change. The RAPPID it returns is the one it was
    /// given, which is the entire point of the type.
    func molted(to stage: MoltStage) -> Companion {
        var copy = self
        copy.stage = stage
        return copy
    }

    /// The stage the accepted frame depth actually supports.
    var derivedStage: MoltStage { MoltStage.derived(fromFrameHeight: frameHeight) }

    var canMolt: Bool {
        guard let next = stage.next else { return false }
        return frameHeight >= next.frameHeightThreshold
    }

    var traitsSorted: [(key: String, milli: Int)] {
        traitsMilli.keys.sorted().map { (key: $0, milli: traitsMilli[$0]!) }
    }
}
