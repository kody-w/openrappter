import Foundation

/// Molt stage is derived presentation state. It never changes the RAPPID.
enum MoltStage: Int, Codable, CaseIterable, Comparable, Identifiable {
    case first = 0
    case second = 1
    case third = 2

    var id: Int { rawValue }

    static func < (lhs: MoltStage, rhs: MoltStage) -> Bool { lhs.rawValue < rhs.rawValue }

    /// The host's canonical lifecycle vocabulary, which this app renders with
    /// its own field names but never renames on the wire.
    var canonicalLifecycle: String {
        switch self {
        case .first: return "baby"
        case .second: return "hatchling"
        case .third: return "raptor"
        }
    }

    var next: MoltStage? {
        MoltStage(rawValue: rawValue + 1)
    }

    /// Contiguous accepted frame depth at which a molt becomes available.
    /// Derived state, and deliberately not a size threshold: maturity is never
    /// inferred from bytes.
    var frameHeightThreshold: Int {
        switch self {
        case .first: return 0
        case .second: return 6
        case .third: return 18
        }
    }

    static func derived(fromFrameHeight height: Int) -> MoltStage {
        if height >= MoltStage.third.frameHeightThreshold { return .third }
        if height >= MoltStage.second.frameHeightThreshold { return .second }
        return .first
    }
}

struct MoltName: Hashable, Codable {
    let stage: MoltStage
    let name: String
}

/// What a molt actually is: a rename of the projection, plus whatever the
/// stage unlocks in the habitat. Never a new organism.
struct MoltDescription {
    let stage: MoltStage
    let name: String
    let summary: String

    static func summary(for stage: MoltStage, path: StarterPath) -> String {
        switch (path, stage) {
        case (.canopy, .first): return "A compact trait seed under cover. Learning what it is allowed to keep."
        case (.canopy, .second): return "Walks the field on its own and carries a durable memory cursor."
        case (.canopy, .third): return "A grown organism: durable memory, recorded skills, and bounded self-steering."
        case (.current, .first): return "A first disturbance in the field. Small, fast, entirely local."
        case (.current, .second): return "Carries several verified dimensions and moves between habitats."
        case (.current, .third): return "Reads and answers the field it is standing in, without losing its own line."
        case (.forge, .first): return "Hot, brief, and loud. Almost nothing is verified yet."
        case (.forge, .second): return "Holds what it caught. Proposals get ambitious around here."
        case (.forge, .third): return "Earns wings on verified frames alone. Reach and range, not a myth."
        }
    }
}
