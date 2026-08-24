import Foundation

/// A local discovery encounter.
///
/// "Local" means local to the companion, not to a place: the signal is derived
/// from the organism's own motif and an encounter counter. Nothing about where
/// the device is is read, requested, or inferred.
struct EncounterState: Equatable, Codable {
    enum Phase: String, Codable {
        case open
        case attuned
        case faded
        case withdrawn
    }

    static let maxSteps = 4
    static let attuneThreshold = 80
    static let startingAttunement = 20
    static let notesToReveal = 8

    let id: String
    let index: Int
    /// An original signal shape, not a creature: `echo`, `drift`, or `chorus`.
    let kind: String
    let pitchClass: Int
    /// 1...3. Stronger signals pull harder and cost more to hold.
    let strength: Int
    var step: Int
    var attunement: Int
    var revealedNotes: Int
    var phase: Phase

    var isOpen: Bool { phase == .open }
    var stepsRemaining: Int { max(0, Self.maxSteps - step) }
}

/// A call-and-response drill over the companion's own motif.
///
/// The fragment for each round is four consecutive notes of the identity
/// motif, and the right answer follows the fragment's shape. The shape is
/// published in the state as `intervals`, so an agent can play it properly
/// from the receipt alone rather than guessing.
struct TrainingState: Equatable, Codable {
    enum Phase: String, Codable {
        case answering
        case complete
    }

    static let totalRounds = 3
    static let fragmentLength = 4

    let id: String
    var round: Int
    var correct: Int
    var phase: Phase
    var prompt: [Int]

    var intervals: [Int] {
        guard prompt.count > 1 else { return [] }
        return zip(prompt.dropFirst(), prompt).map { $0 - $1 }
    }

    var isOpen: Bool { phase == .answering }
}

/// Everything the game itself knows. Derived state only — it never touches a
/// RAPPID, and nothing here can append a body frame.
struct GameState: Equatable {
    /// 0...100. Raised by resolved encounters and correct drill answers.
    var attunement = 0
    var encountersResolved = 0
    var drillsCompleted = 0
    var encounter: EncounterState?
    var training: TrainingState?
    /// A short, human-readable note about what just happened.
    var lastOutcome: String?

    static let attunementCeiling = 100
}

/// What the game's progress looks like to the proposal provider.
struct GameProgress: Equatable {
    var attunement: Int
    var encountersResolved: Int
    var drillsCompleted: Int

    static let initial = GameProgress(attunement: 0, encountersResolved: 0, drillsCompleted: 0)

    init(attunement: Int = 0, encountersResolved: Int = 0, drillsCompleted: Int = 0) {
        self.attunement = attunement
        self.encountersResolved = encountersResolved
        self.drillsCompleted = drillsCompleted
    }

    init(_ state: GameState) {
        self.init(
            attunement: state.attunement,
            encountersResolved: state.encountersResolved,
            drillsCompleted: state.drillsCompleted
        )
    }
}

/// The deterministic content rules. Same companion, same encounter, forever.
enum GameRules {
    static let encounterKinds = ["echo", "drift", "chorus"]

    static func makeEncounter(rappid: String, index: Int, motif: [Int]) -> EncounterState {
        let seed = Digest.sha256Hex(CanonicalJSON.render(.object([
            "rappid": .string(rappid),
            "index": .int(index),
            "purpose": .string("discovery-encounter"),
        ])))
        var stream = DeterministicStream(seed: seed)
        let kind = encounterKinds[stream.nextBelow(encounterKinds.count)]
        let strength = 1 + stream.nextBelow(3)
        let pitch = motif.isEmpty ? 60 : motif[stream.nextBelow(motif.count)]
        return EncounterState(
            id: "encounter-" + String(seed.prefix(12)),
            index: index,
            kind: kind,
            pitchClass: pitch % 12,
            strength: strength,
            step: 0,
            attunement: EncounterState.startingAttunement,
            revealedNotes: 0,
            phase: .open
        )
    }

    /// The move table. Integer arithmetic only, so a move plays out the same
    /// way for a person and for an agent reading the same numbers.
    static func apply(_ move: EncounterMove, to encounter: EncounterState) -> EncounterState {
        var next = encounter
        guard next.isOpen else { return next }

        switch move {
        case .withdraw:
            next.phase = .withdrawn
            return next
        case .listen:
            next.attunement += 8 + next.strength * 2
            next.revealedNotes = min(EncounterState.notesToReveal, next.revealedNotes + 1)
        case .approach:
            // Closing early is how an encounter is lost.
            next.attunement += next.revealedNotes >= 2 ? 26 : -14
        case .steady:
            next.attunement += 6
        }

        next.step += 1
        // Holding a signal costs something every step.
        next.attunement -= next.strength
        next.attunement = max(0, min(100, next.attunement))

        if next.attunement >= EncounterState.attuneThreshold {
            next.phase = .attuned
        } else if next.attunement <= 0 || next.step >= EncounterState.maxSteps {
            next.phase = next.attunement >= EncounterState.attuneThreshold ? .attuned : .faded
        }
        return next
    }

    static func makeTraining(rappid: String, motif: [Int]) -> TrainingState {
        let seed = Digest.sha256Hex(CanonicalJSON.render(.object([
            "rappid": .string(rappid),
            "purpose": .string("training-drill"),
        ])))
        return TrainingState(
            id: "drill-" + String(seed.prefix(12)),
            round: 0,
            correct: 0,
            phase: .answering,
            prompt: fragment(motif: motif, round: 0)
        )
    }

    static func fragment(motif: [Int], round: Int) -> [Int] {
        guard !motif.isEmpty else { return [] }
        let start = (round * TrainingState.fragmentLength) % motif.count
        return (0..<TrainingState.fragmentLength).map { motif[(start + $0) % motif.count] }
    }

    /// Rising fragments are carried further, falling ones are turned over, and
    /// a level one is answered back. The rule is published so it can be played.
    static func expectedAnswer(for prompt: [Int]) -> TrainingAnswer {
        guard prompt.count > 1 else { return .echo }
        let shape = zip(prompt.dropFirst(), prompt).map { $0 - $1 }.reduce(0, +)
        if shape > 0 { return .extend }
        if shape < 0 { return .invert }
        return .echo
    }
}
