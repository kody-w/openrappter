import Foundation

/// The read-only facts the rules need from outside the game itself.
struct GameContext: Equatable {
    var onboardingComplete = false
    var chosenPath: StarterPath?
    var onboardingSelection: StarterPath?
    var companionRappid: String?
    var motif: [Int] = []
    var rosterPaths: [StarterPath] = []
    var leash: SelfSteerLeash = .propose
    var hasProposal = false
    var proposalID: String?
    var confirmationVisible = false
    var confirmationAcknowledged = false
    var isPlayingSonic = false
}

/// Something the world outside the rules must do afterwards.
enum GameEffect: Equatable {
    case selectStarter(StarterPath)
    case commitStarter(StarterPath)
    case openScreen(FieldTab)
    case selectCompanion(StarterPath)
    case playSonic
    case stopSonic
    case setLeash(SelfSteerLeash)
    case refreshProposal
    case openConfirmation
    case acknowledgeConfirmation(String)
    case dismissConfirmation
    case performAppend
    case resetField
}

struct GameOutcome: Equatable {
    var state: GameState
    var effects: [GameEffect]
}

/// The rules, as one pure function.
///
/// Buttons and autopilot commands both arrive here, so "what the game allows"
/// is written once. `availableCommands` is computed by asking this same
/// function what it would refuse, which is why the advertised action list can
/// never drift from the behaviour.
enum GameReducer {
    static func reduce(state: GameState, command: GameCommand, context: GameContext) throws -> GameOutcome {
        var next = state
        var effects: [GameEffect] = []

        switch command {
        case let .selectStarter(path):
            guard !context.onboardingComplete else { throw GameRefusal.starterAlreadyChosen }
            effects.append(.selectStarter(path))

        case .confirmStarter:
            guard !context.onboardingComplete else { throw GameRefusal.starterAlreadyChosen }
            guard let selection = context.onboardingSelection else { throw GameRefusal.starterNotSelected }
            effects.append(.stopSonic)
            effects.append(.commitStarter(selection))
            effects.append(.refreshProposal)

        case let .openScreen(tab):
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            effects.append(.openScreen(tab))

        case let .selectCompanion(path):
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            guard context.rosterPaths.contains(path) else { throw GameRefusal.noCompanion }
            effects.append(.stopSonic)
            effects.append(.selectCompanion(path))
            effects.append(.refreshProposal)

        case .playSonicIdentity:
            guard context.companionRappid != nil else { throw GameRefusal.noCompanion }
            guard !context.isPlayingSonic else { throw GameRefusal.alreadyPlaying }
            effects.append(.playSonic)

        case .stopSonicIdentity:
            guard context.isPlayingSonic else { throw GameRefusal.nothingIsPlaying }
            effects.append(.stopSonic)

        case .beginEncounter:
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            guard let rappid = context.companionRappid else { throw GameRefusal.noCompanion }
            if let open = next.encounter, open.isOpen { throw GameRefusal.encounterAlreadyOpen }
            next.encounter = GameRules.makeEncounter(
                rappid: rappid,
                index: next.encountersResolved,
                motif: context.motif
            )
            next.lastOutcome = "A \(next.encounter!.kind) signal is holding at strength \(next.encounter!.strength)."

        case let .encounterMove(move):
            guard let open = next.encounter, open.isOpen else { throw GameRefusal.noOpenEncounter }
            let resolved = GameRules.apply(move, to: open)
            next.encounter = resolved
            switch resolved.phase {
            case .open:
                next.lastOutcome = "\(move.rawValue): attunement \(resolved.attunement), \(resolved.stepsRemaining) steps left."
            case .attuned:
                next.encountersResolved += 1
                next.attunement = min(GameState.attunementCeiling, next.attunement + 20)
                next.lastOutcome = "The signal attuned. Field attunement is now \(next.attunement)."
            case .faded:
                next.lastOutcome = "The signal faded before you reached it."
            case .withdrawn:
                next.lastOutcome = "You withdrew. Nothing gained, nothing lost."
            }

        case .leaveEncounter:
            guard next.encounter != nil else { throw GameRefusal.noOpenEncounter }
            next.encounter = nil
            next.lastOutcome = "The field is quiet again."

        case .beginTraining:
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            guard let rappid = context.companionRappid else { throw GameRefusal.noCompanion }
            if let open = next.training, open.isOpen { throw GameRefusal.trainingAlreadyOpen }
            next.training = GameRules.makeTraining(rappid: rappid, motif: context.motif)
            next.lastOutcome = "Round 1 of \(TrainingState.totalRounds). Answer the shape of the fragment."

        case let .trainingAnswer(answer):
            guard var drill = next.training, drill.isOpen else { throw GameRefusal.noOpenTraining }
            let expected = GameRules.expectedAnswer(for: drill.prompt)
            let wasRight = answer == expected
            if wasRight { drill.correct += 1 }
            drill.round += 1
            if drill.round >= TrainingState.totalRounds {
                drill.phase = .complete
                next.drillsCompleted += 1
                next.attunement = min(GameState.attunementCeiling, next.attunement + drill.correct * 5)
                next.lastOutcome = "Drill complete: \(drill.correct) of \(TrainingState.totalRounds) right."
            } else {
                drill.prompt = GameRules.fragment(motif: context.motif, round: drill.round)
                next.lastOutcome = wasRight
                    ? "Right. Round \(drill.round + 1) of \(TrainingState.totalRounds)."
                    : "It wanted \(expected.rawValue). Round \(drill.round + 1) of \(TrainingState.totalRounds)."
            }
            next.training = drill

        case .endTraining:
            guard next.training != nil else { throw GameRefusal.noOpenTraining }
            next.training = nil
            next.lastOutcome = "Drill put away."

        case let .setLeash(leash):
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            effects.append(.setLeash(leash))
            effects.append(.refreshProposal)

        case .requestProposal:
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            guard context.companionRappid != nil else { throw GameRefusal.noCompanion }
            guard GrowthLeashPolicy.mayPropose(leash: context.leash) else {
                throw GameRefusal.leashObserves(context.leash)
            }
            effects.append(.refreshProposal)

        case .openConfirmation:
            guard context.hasProposal else { throw GameRefusal.noProposal }
            effects.append(.openConfirmation)

        case let .acknowledgeConfirmation(proposalID):
            guard context.confirmationVisible else { throw GameRefusal.confirmationNotOpen }
            guard context.proposalID == proposalID else { throw GameRefusal.proposalChanged }
            effects.append(.acknowledgeConfirmation(proposalID))

        case .approveAppend:
            // The same two gates a finger meets. Whatever happens after this,
            // `AppModel.append` still runs the whole leash policy.
            guard context.confirmationVisible else { throw GameRefusal.confirmationNotOpen }
            guard context.confirmationAcknowledged else { throw GameRefusal.confirmationNotAcknowledged }
            effects.append(.performAppend)

        case .cancelAppend:
            guard context.confirmationVisible else { throw GameRefusal.confirmationNotOpen }
            effects.append(.dismissConfirmation)

        case .resetField:
            guard context.onboardingComplete else { throw GameRefusal.onboardingIncomplete }
            next = GameState()
            effects.append(.stopSonic)
            effects.append(.resetField)
        }

        return GameOutcome(state: next, effects: effects)
    }

    /// What the game would accept right now, named exactly as the wire names
    /// them. Derived by asking `reduce`, never by a second list of rules.
    static func availableCommands(state: GameState, context: GameContext) -> [String] {
        var names: [String] = []
        for command in GameCommand.representatives(proposalID: context.proposalID) {
            guard (try? reduce(state: state, command: command, context: context)) != nil else { continue }
            if !names.contains(command.name) { names.append(command.name) }
        }
        return names.sorted()
    }
}
