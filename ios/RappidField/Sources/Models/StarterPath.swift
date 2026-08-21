import Foundation

/// How much the field asks of the operator. Never a statement about the person.
enum ChallengeTier: String, Codable, CaseIterable {
    case guided
    case adaptive
    case frontier

    var label: String {
        switch self {
        case .guided: return "Guided"
        case .adaptive: return "Adaptive"
        case .frontier: return "Frontier"
        }
    }

    var effort: String {
        switch self {
        case .guided: return "Easy"
        case .adaptive: return "Medium"
        case .frontier: return "Hard"
        }
    }
}

/// The self-steer leash. There is no hidden full-autonomy mode.
enum SelfSteerLeash: String, Codable, CaseIterable, Identifiable {
    case observe
    case propose
    case runApproved

    var id: String { rawValue }

    var label: String {
        switch self {
        case .observe: return "Observe"
        case .propose: return "Propose"
        case .runApproved: return "Run Approved"
        }
    }

    var explanation: String {
        switch self {
        case .observe:
            return "Watches and measures only. No proposal is generated."
        case .propose:
            return "Generates proposals for you to read. Nothing is ever appended."
        case .runApproved:
            return "Appends only the exact proposal you approved, one at a time."
        }
    }

    /// The leash never implies consent to append; approval is a separate act.
    var allowsAppendAfterApproval: Bool { self == .runApproved }
}

struct TraitEmphasis: Identifiable, Hashable {
    let key: String
    let label: String
    let note: String

    var id: String { key }
}

/// The three original starter paths.
///
/// The paths describe how much the field steers you and what the companion
/// leans toward. They are not elements, not types, and carry no advantage
/// triangle: a path is a posture, not a counter.
enum StarterPath: String, Codable, CaseIterable, Identifiable {
    case canopy
    case current
    case forge

    var id: String { rawValue }

    /// This app never asks for, stores, or infers an operator's age, and no
    /// path is gated. The recommendation below is advice, and nothing reads it.
    static let collectsOperatorAge = false
    static let gatesPathsByAge = false

    var displayName: String {
        switch self {
        case .canopy: return "Canopy"
        case .current: return "Current"
        case .forge: return "Forge"
        }
    }

    var challenge: ChallengeTier {
        switch self {
        case .canopy: return .guided
        case .current: return .adaptive
        case .forge: return .frontier
        }
    }

    var tagline: String {
        switch self {
        case .canopy: return "Grows in shelter, remembers everything."
        case .current: return "Moves with the field, adapts to what it meets."
        case .forge: return "Runs at the edge, pays for it, learns fastest."
        }
    }

    /// What the path asks of you.
    var challengeSummary: String {
        switch self {
        case .canopy:
            return "Every step is explained before it happens. Growth is slow, reversible, and always waits for you. Recommended if you are new to field work, or setting one up for someone who is."
        case .current:
            return "The field meets you halfway. Proposals arrive more often, and a few of them will be wrong in ways you have to catch."
        case .forge:
            return "Little hand-holding. Proposals are frequent, ambitious, and sometimes bad. You will spend real attention reading them."
        }
    }

    /// What the path does with data. Identical guarantees on all three.
    var privacySummary: String {
        switch self {
        case .canopy:
            return "Nothing leaves this device unless you pair it with your own host. No location, no account, no age, no analytics."
        case .current:
            return "Nothing leaves this device unless you pair it with your own host. Pairing is scoped and revocable from the host at any time."
        case .forge:
            return "Nothing leaves this device unless you pair it with your own host. Frontier growth still refuses to append anything you have not read and approved."
        }
    }

    /// What you get for the trouble.
    var payoffSummary: String {
        switch self {
        case .canopy:
            return "A companion with a long, steady memory that rarely surprises you and never loses the thread."
        case .current:
            return "A companion that keeps up with a changing day and carries a balanced spread of dimensions."
        case .forge:
            return "The widest ceiling in the app. A Forge companion that survives its own proposals grows dimensions the other paths take far longer to reach."
        }
    }

    var riskSummary: String {
        switch self {
        case .canopy: return "Low risk, low variance. Slowest ceiling."
        case .current: return "Balanced risk. Middling ceiling, fewest dead ends."
        case .forge: return "High risk, high payoff. Rejected proposals cost frame height you do not get back."
        }
    }

    var recommendation: String? {
        switch self {
        case .canopy:
            return "Recommended for a first companion, and for younger or brand-new operators. Nothing checks; nothing is locked."
        case .current, .forge:
            return nil
        }
    }

    var defaultLeash: SelfSteerLeash {
        switch self {
        case .canopy: return .observe
        case .current: return .propose
        case .forge: return .propose
        }
    }

    var traitEmphasis: [TraitEmphasis] {
        switch self {
        case .canopy:
            return [
                TraitEmphasis(key: "safety", label: "Safety", note: "Refuses more, earlier."),
                TraitEmphasis(key: "continuity", label: "Steady memory", note: "Holds a thread across days."),
            ]
        case .current:
            return [
                TraitEmphasis(key: "resonance", label: "Resonance", note: "Reads the room it is in."),
                TraitEmphasis(key: "curiosity", label: "Curiosity", note: "Looks for the next dimension."),
            ]
        case .forge:
            return [
                TraitEmphasis(key: "autonomy", label: "Autonomy", note: "Proposes without being asked."),
                TraitEmphasis(key: "curiosity", label: "Curiosity", note: "Reaches past what it has verified."),
            ]
        }
    }

    /// The birth trait snapshot, in exact thousandths. Frozen at mint time:
    /// this is the only trait form the deterministic providers ever score with.
    var birthTraitsMilli: [String: Int] {
        switch self {
        case .canopy:
            return ["autonomy": 180, "continuity": 720, "curiosity": 430, "resonance": 500, "safety": 880]
        case .current:
            return ["autonomy": 480, "continuity": 540, "curiosity": 600, "resonance": 640, "safety": 560]
        case .forge:
            return ["autonomy": 860, "continuity": 330, "curiosity": 880, "resonance": 700, "safety": 300]
        }
    }

    /// The molt line. Same identity throughout; only the presentation changes.
    var moltLine: [MoltName] {
        switch self {
        case .canopy:
            return [
                MoltName(stage: .first, name: "Seedling"),
                MoltName(stage: .second, name: "Strider"),
                MoltName(stage: .third, name: "Raptor"),
            ]
        case .current:
            return [
                MoltName(stage: .first, name: "Ripple"),
                MoltName(stage: .second, name: "Voyager"),
                MoltName(stage: .third, name: "Resonant"),
            ]
        case .forge:
            return [
                MoltName(stage: .first, name: "Spark"),
                MoltName(stage: .second, name: "Talon"),
                MoltName(stage: .third, name: "Aetherwing"),
            ]
        }
    }

    func moltName(for stage: MoltStage) -> String {
        moltLine.first { $0.stage == stage }!.name
    }
}
