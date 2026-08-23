import Foundation

/// A move in a discovery encounter.
enum EncounterMove: String, CaseIterable, Codable {
    case listen
    case approach
    case steady
    case withdraw

    var explanation: String {
        switch self {
        case .listen: return "Hold still and reveal another note of the signal. Safe, and it is how you learn the shape."
        case .approach: return "Close the distance. Strong once you have heard enough; costly when you have not."
        case .steady: return "Hold the line. Small gain, and it settles the pressure you are under."
        case .withdraw: return "Leave the signal alone. Nothing gained, nothing lost."
        }
    }
}

/// An answer in a call-and-response drill.
enum TrainingAnswer: String, CaseIterable, Codable {
    case echo
    case invert
    case extend

    var explanation: String {
        switch self {
        case .echo: return "Answer it back unchanged. Right when the fragment holds level."
        case .invert: return "Answer it upside down. Right when the fragment falls."
        case .extend: return "Carry it further. Right when the fragment rises."
        }
    }
}

/// Everything the game can be asked to do, by a finger or by an agent.
///
/// One vocabulary, one reducer. A button and an autopilot command land on the
/// same case, so there is no second implementation of the rules for automation
/// to drift away from.
enum GameCommand: Equatable {
    case selectStarter(StarterPath)
    case confirmStarter
    case openScreen(FieldTab)
    case selectCompanion(StarterPath)
    case playSonicIdentity
    case stopSonicIdentity
    case beginEncounter
    case encounterMove(EncounterMove)
    case leaveEncounter
    case beginTraining
    case trainingAnswer(TrainingAnswer)
    case endTraining
    case setLeash(SelfSteerLeash)
    case requestProposal
    case openConfirmation
    case acknowledgeConfirmation(String)
    case approveAppend
    case cancelAppend
    case resetField

    /// The name this command answers to on the wire. It is the same string the
    /// autopilot allowlist uses, so `availableActions` needs no translation.
    var name: String {
        switch self {
        case .selectStarter: return "selectStarter"
        case .confirmStarter: return "confirmStarter"
        case .openScreen: return "navigate"
        case .selectCompanion: return "openCard"
        case .playSonicIdentity: return "playWakeCall"
        case .stopSonicIdentity: return "stopWakeCall"
        case .beginEncounter: return "beginEncounter"
        case .encounterMove: return "encounterMove"
        case .leaveEncounter: return "leaveEncounter"
        case .beginTraining: return "beginTraining"
        case .trainingAnswer: return "trainingAnswer"
        case .endTraining: return "endTraining"
        case .setLeash: return "setLeash"
        case .requestProposal: return "requestProposal"
        case .openConfirmation: return "openConfirmation"
        case .acknowledgeConfirmation: return "acknowledgeConfirmation"
        case .approveAppend: return "approveAppend"
        case .cancelAppend: return "cancelAppend"
        case .resetField: return "resetSyntheticState"
        }
    }

    /// One representative of every command, used to compute what is currently
    /// available by asking the reducer rather than by writing the rules twice.
    static func representatives(proposalID: String?) -> [GameCommand] {
        [
            .selectStarter(.canopy),
            .confirmStarter,
            .openScreen(.fieldGuide),
            .selectCompanion(.canopy),
            .playSonicIdentity,
            .stopSonicIdentity,
            .beginEncounter,
            .encounterMove(.listen),
            .leaveEncounter,
            .beginTraining,
            .trainingAnswer(.echo),
            .endTraining,
            .setLeash(.propose),
            .requestProposal,
            .openConfirmation,
            .acknowledgeConfirmation(proposalID ?? ""),
            .approveAppend,
            .cancelAppend,
            .resetField,
        ]
    }
}

enum GameRefusal: LocalizedError, Equatable {
    case onboardingIncomplete
    case starterAlreadyChosen
    case starterNotSelected
    case noCompanion
    case encounterAlreadyOpen
    case noOpenEncounter
    case trainingAlreadyOpen
    case noOpenTraining
    case leashObserves(SelfSteerLeash)
    case noProposal
    case confirmationNotOpen
    case confirmationNotAcknowledged
    case proposalChanged
    case nothingIsPlaying
    case alreadyPlaying

    var code: String {
        switch self {
        case .onboardingIncomplete: return "onboarding-incomplete"
        case .starterAlreadyChosen: return "starter-already-chosen"
        case .starterNotSelected: return "starter-not-selected"
        case .noCompanion: return "no-companion"
        case .encounterAlreadyOpen: return "encounter-already-open"
        case .noOpenEncounter: return "no-open-encounter"
        case .trainingAlreadyOpen: return "training-already-open"
        case .noOpenTraining: return "no-open-training"
        case .leashObserves: return "leash-observes"
        case .noProposal: return "no-proposal"
        case .confirmationNotOpen: return "confirmation-not-open"
        case .confirmationNotAcknowledged: return "confirmation-not-acknowledged"
        case .proposalChanged: return "proposal-changed"
        case .nothingIsPlaying: return "nothing-is-playing"
        case .alreadyPlaying: return "already-playing"
        }
    }

    var errorDescription: String? {
        switch self {
        case .onboardingIncomplete: return "Choose a starter path first."
        case .starterAlreadyChosen: return "A starter path has already been chosen for this field."
        case .starterNotSelected: return "No starter path is selected yet."
        case .noCompanion: return "No companion is loaded."
        case .encounterAlreadyOpen: return "An encounter is already open."
        case .noOpenEncounter: return "There is no open encounter."
        case .trainingAlreadyOpen: return "A drill is already running."
        case .noOpenTraining: return "There is no drill running."
        case let .leashObserves(leash): return "The leash is set to \(leash.label); no proposal is generated."
        case .noProposal: return "There is no proposal to act on."
        case .confirmationNotOpen: return "The confirmation sheet is not open."
        case .confirmationNotAcknowledged: return "The confirmation has not been acknowledged."
        case .proposalChanged: return "The proposal changed before it could be acknowledged."
        case .nothingIsPlaying: return "Nothing is playing."
        case .alreadyPlaying: return "The wake call is already playing."
        }
    }
}
