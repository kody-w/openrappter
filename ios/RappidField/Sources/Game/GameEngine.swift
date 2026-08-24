import Foundation
import Observation

/// The one place a game command becomes something that happened.
///
/// Every button in the app and every autopilot command calls `apply`, so a
/// person and an agent are playing the same game rather than two
/// implementations of it. The rules themselves live in `GameReducer` and are
/// pure; this type only carries out the effects the rules asked for.
@MainActor
@Observable
final class GameEngine {
    private(set) var state = GameState()
    private(set) var lastRefusal: String?

    private let model: AppModel
    private let navigator: FieldNavigator
    private let player: WakeCallPlayer
    private var signatures: [String: SonicSignature] = [:]

    init(model: AppModel, navigator: FieldNavigator, player: WakeCallPlayer) {
        self.model = model
        self.navigator = navigator
        self.player = player
    }

    // MARK: Reading the world

    var progress: GameProgress { GameProgress(state) }

    var context: GameContext {
        let companion = model.selectedCompanion
        return GameContext(
            onboardingComplete: model.onboardingComplete,
            chosenPath: model.chosenPath,
            onboardingSelection: navigator.onboardingSelection,
            companionRappid: companion?.identity.description,
            motif: companion.map { signature(for: $0).prompt.map(\.pitch) } ?? [],
            rosterPaths: model.roster.map(\.path),
            leash: model.leash,
            hasProposal: navigator.proposal != nil,
            proposalID: navigator.proposal?.id,
            confirmationVisible: navigator.confirmationVisible,
            confirmationAcknowledged: navigator.confirmationAcknowledged,
            isPlayingSonic: player.isPlaying
        )
    }

    /// Named exactly as the wire names them, so an agent can read this list and
    /// send one straight back.
    var availableActions: [String] {
        GameReducer.availableCommands(state: state, context: context)
    }

    /// Deriving a signature costs a hash and a MIDI render, so it is kept.
    func signature(for companion: Companion) -> SonicSignature {
        let key = companion.identity.description
        if let cached = signatures[key] { return cached }
        let made = SonicSignature(rappid: companion.identity, birthTraitsMilli: companion.birthTraitsMilli)
        signatures[key] = made
        return made
    }

    // MARK: Playing

    @discardableResult
    func apply(_ command: GameCommand) async throws -> GameState {
        let outcome: GameOutcome
        do {
            outcome = try GameReducer.reduce(state: state, command: command, context: context)
        } catch let refusal as GameRefusal {
            lastRefusal = refusal.errorDescription
            throw refusal
        }
        state = outcome.state
        lastRefusal = nil
        for effect in outcome.effects {
            try await perform(effect)
        }
        return state
    }

    /// A convenience for the views, which want to dispatch from a button.
    func dispatch(_ command: GameCommand) {
        Task { try? await apply(command) }
    }

    /// Recomputes the pending proposal without asking for one. The view uses
    /// this to stay in sync; `requestProposal` is the command that asks.
    func syncProposal() {
        guard model.onboardingComplete, model.selectedCompanion != nil,
              GrowthLeashPolicy.mayPropose(leash: model.leash) else {
            navigator.proposal = nil
            return
        }
        navigator.refreshProposal(model: model, progress: progress)
    }

    private func perform(_ effect: GameEffect) async throws {
        switch effect {
        case let .selectStarter(path):
            navigator.onboardingSelection = path
            navigator.onboardingStage = .confirm

        case let .commitStarter(path):
            model.choose(path: path)
            model.completeOnboarding()
            navigator.onboardingStage = .complete

        case let .openScreen(tab):
            navigator.selectedTab = tab

        case let .selectCompanion(path):
            guard let companion = model.roster.first(where: { $0.path == path }) else { return }
            navigator.selectedTab = .fieldGuide
            model.selectedCompanionID = companion.id

        case .playSonic:
            guard let companion = model.selectedCompanion else { return }
            player.play(signature: signature(for: companion))

        case .stopSonic:
            player.stop()

        case let .setLeash(leash):
            model.setLeash(leash)

        case .refreshProposal:
            syncProposal()

        case .openConfirmation:
            navigator.openConfirmation()

        case let .acknowledgeConfirmation(proposalID):
            try navigator.acknowledgeProposal(id: proposalID)

        case .dismissConfirmation:
            navigator.dismissConfirmation()

        case .performAppend:
            try await navigator.confirmAppend(model: model)

        case .resetField:
            navigator.reset()
            try await model.resetToSyntheticField()
            syncProposal()
        }
    }
}
