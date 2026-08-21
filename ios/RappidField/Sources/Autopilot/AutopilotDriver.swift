// Debug autopilot. The whole file is compiled out of Release builds;
// see AutopilotGate for the second, explicit launch-time lock.
#if DEBUG
import Foundation
import Observation

/// Executes allowlisted autopilot commands and answers every one with a
/// receipt.
///
/// Anything that is a move in the game is handed to `GameEngine`, which is the
/// same path every button takes — an agent and a person are playing one game,
/// not two. What is left here is the handful of things that are not game
/// rules: pairing input, the conversation, and reading state back.
@MainActor
@Observable
final class AutopilotDriver {
    static let historyLimit = 256
    static let defaultSettleTimeout: Duration = .seconds(8)
    static let defaultAnimationSettle: Duration = .milliseconds(120)

    let isEnabled: Bool
    private let model: AppModel
    private let navigator: FieldNavigator
    private let player: WakeCallPlayer
    private let engine: GameEngine
    /// Where commands are collected from. Each is polled independently.
    private let inboxes: [AutopilotMailbox]
    /// Where receipts are published. The pasteboard is always one of these, so
    /// `simctl pbpaste` reads the answer however the command arrived.
    private let publishers: [AutopilotMailbox]

    private var seenOrder: [String] = []
    private var seenIDs: Set<String> = []
    private var lastChangeCounts: [ObjectIdentifier: Int] = [:]
    private var pollTask: Task<Void, Never>?

    private(set) var isPolling = false
    private(set) var executedCount = 0
    /// The highest sequence number accepted so far. A caller reads it back off
    /// every receipt and can resynchronise from it.
    private(set) var cursor = 0
    private var isExecuting = false
    var pollInterval: Duration = .milliseconds(200)
    /// How long the driver will wait for the world to come to rest before it
    /// gives up and says so in a receipt.
    var settleTimeout: Duration = AutopilotDriver.defaultSettleTimeout
    /// A short, fixed pause after a move that animates, so the receipt
    /// describes the settled screen rather than a screen mid-transition.
    var animationSettle: Duration = AutopilotDriver.defaultAnimationSettle

    init(
        model: AppModel,
        navigator: FieldNavigator,
        player: WakeCallPlayer,
        engine: GameEngine,
        inboxes: [AutopilotMailbox],
        publishers: [AutopilotMailbox],
        isEnabled: Bool
    ) {
        self.model = model
        self.navigator = navigator
        self.player = player
        self.engine = engine
        self.inboxes = inboxes
        self.publishers = publishers
        self.isEnabled = isEnabled
    }

    convenience init(
        model: AppModel,
        navigator: FieldNavigator,
        player: WakeCallPlayer,
        engine: GameEngine,
        mailbox: AutopilotMailbox,
        isEnabled: Bool
    ) {
        self.init(
            model: model,
            navigator: navigator,
            player: player,
            engine: engine,
            inboxes: [mailbox],
            publishers: [mailbox],
            isEnabled: isEnabled
        )
    }

    // MARK: Carriers

    /// Foreground-only polling of every mailbox.
    func resume() {
        guard isEnabled, pollTask == nil else { return }
        isPolling = true
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                try? await Task.sleep(for: self.pollInterval)
            }
        }
    }

    func suspend() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }

    func pollOnce() async {
        guard isEnabled else { return }
        for inbox in inboxes {
            let key = ObjectIdentifier(inbox)
            let count = inbox.changeCount
            guard count != lastChangeCounts[key] else { continue }
            lastChangeCounts[key] = count
            guard let payload = inbox.read() else { continue }
            guard let receipt = await handle(payload: payload) else { continue }
            publish(receipt)
        }
    }

    private func publish(_ receipt: AutopilotReceipt) {
        let encoded = receipt.encoded()
        for publisher in publishers {
            let before = publisher.changeCount
            publisher.write(encoded)
            // A pasteboard-style mailbox changes its own inbox generation when
            // a receipt is written, so mark that receipt seen. The container
            // mailbox writes receipt.json without changing inbox.json; if a
            // new command arrived during execution its generation must remain
            // unread so the next poll can answer it.
            guard publisher.changeCount != before else { continue }
            for inbox in inboxes where inbox === publisher {
                lastChangeCounts[ObjectIdentifier(inbox)] = inbox.changeCount
            }
        }
    }

    // MARK: Command pipeline

    /// Returns `nil` when the payload is not ours; the operator's own clipboard
    /// contents must never produce a receipt.
    ///
    /// One command at a time, in order: a command is refused unless it is
    /// new, past the cursor, and arriving while nothing else is running. The
    /// receipt is written only after the move has been carried out *and* the
    /// app has come to rest, so a caller that waits for it is never racing an
    /// animation or a service.
    func handle(payload: String) async -> AutopilotReceipt? {
        guard isEnabled else { return nil }

        switch AutopilotParser.parse(payload) {
        case .ignored:
            return nil
        case let .refused(id, refusal):
            return receipt(id: id, seq: 0, status: .refused, error: refusal.code)
        case let .command(command):
            guard !isExecuting else {
                return refusal(command, .busy("another command is still running"))
            }
            guard !seenIDs.contains(command.id) else {
                return refusal(command, .duplicateIdentifier)
            }
            guard command.seq > cursor else {
                return refusal(command, .staleSequence(seq: command.seq, cursor: cursor))
            }
            remember(command.id)
            // The cursor is consumed by acceptance, whatever the outcome, so a
            // refused move never leaves a hole a replay could slip into.
            cursor = command.seq
            isExecuting = true
            defer { isExecuting = false }
            do {
                try await execute(command)
                try await settle(after: command)
                executedCount += 1
                return receipt(id: command.id, seq: command.seq, status: .ok, error: nil)
            } catch let refusal as AutopilotRefusal {
                let status: AutopilotStatus = {
                    if case .commandTimedOut = refusal { return .error }
                    return .refused
                }()
                return receipt(id: command.id, seq: command.seq, status: status, error: refusal.code)
            } catch let refusal as GameRefusal {
                return receipt(id: command.id, seq: command.seq, status: .refused, error: Self.autopilotRefusal(for: refusal).code)
            } catch let refusal as AppendRefusal {
                return receipt(id: command.id, seq: command.seq, status: .refused, error: refusal.errorDescription ?? "append refused")
            } catch {
                return receipt(id: command.id, seq: command.seq, status: .error, error: error.localizedDescription)
            }
        }
    }

    /// Waits for the move to have actually happened.
    ///
    /// A receipt that arrives while a service is mid-flight or a sheet is
    /// mid-animation would let a caller assert against a state that is about to
    /// change under it. If rest cannot be reached inside `settleTimeout`, that
    /// is reported as a deterministic `command-timeout` receipt rather than a
    /// hang.
    private func settle(after command: AutopilotCommand) async throws {
        // Let the current main-actor turn finish so observable state has landed.
        await Task.yield()

        let started = ContinuousClock.now
        func waitUntil(_ label: String, _ isSettled: () -> Bool) async throws {
            while !isSettled() {
                guard started.duration(to: .now) < settleTimeout else {
                    throw AutopilotRefusal.commandTimedOut("\(command.action.rawValue): \(label)")
                }
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        // Any habitat call the move started.
        try await waitUntil("the field never finished loading") { self.model.loadState != .loading }

        // The conversation is a service too: a sent message is settled when it
        // commits, fails, or is cancelled — never while it is still buffering.
        if command.action == .sendChat {
            try await waitUntil("the reply never committed") { !self.navigator.chat.isReceiving }
        }

        if Self.animates(command.action), animationSettle > .zero {
            try? await Task.sleep(for: animationSettle)
        }
    }

    /// Moves that change a screen, a sheet, or a selection animate.
    static func animates(_ action: AutopilotAction) -> Bool {
        switch action {
        case .navigate, .openCard, .selectStarter, .confirmStarter,
             .openConfirmation, .cancelAppend, .approveAppend, .resetSyntheticState:
            return true
        default:
            return false
        }
    }

    private func remember(_ id: String) {
        seenIDs.insert(id)
        seenOrder.append(id)
        while seenOrder.count > Self.historyLimit {
            seenIDs.remove(seenOrder.removeFirst())
        }
    }

    private func refusal(_ command: AutopilotCommand, _ refusal: AutopilotRefusal) -> AutopilotReceipt {
        receipt(id: command.id, seq: command.seq, status: .refused, error: refusal.code)
    }

    private func receipt(id: String, seq: Int, status: AutopilotStatus, error: String?) -> AutopilotReceipt {
        AutopilotReceipt(
            id: id,
            seq: seq,
            cursor: cursor,
            status: status,
            state: snapshot(),
            error: error.map(AutopilotReceipt.truncatedError)
        )
    }

    /// A refused move keeps the shape the wire already knows: the two
    /// confirmation gates stay `requires-operator-confirmation`, everything
    /// else is `not-applicable` with the rule's own words.
    static func autopilotRefusal(for refusal: GameRefusal) -> AutopilotRefusal {
        switch refusal {
        case .confirmationNotOpen, .confirmationNotAcknowledged:
            return .requiresOperatorConfirmation(refusal.errorDescription ?? refusal.code)
        default:
            return .notApplicable(refusal.errorDescription ?? refusal.code)
        }
    }

    private func requireValue(_ command: AutopilotCommand) throws -> String {
        guard let value = command.value, !value.isEmpty else { throw AutopilotRefusal.valueMissing }
        return value
    }

    private func requireTarget(_ command: AutopilotCommand) throws -> String {
        guard let target = command.target ?? command.value, !target.isEmpty else {
            throw AutopilotRefusal.badTarget("missing")
        }
        return target
    }

    /// Maps a wire command onto a game command, or `nil` when it is not a move
    /// in the game.
    private func gameCommand(for command: AutopilotCommand) throws -> GameCommand? {
        switch command.action {
        case .navigate:
            let target = try requireTarget(command)
            guard let tab = FieldTab.named(target) else {
                throw AutopilotRefusal.badTarget("no screen named \(target)")
            }
            return .openScreen(tab)

        case .selectStarter:
            let target = try requireTarget(command)
            guard let path = StarterPath(rawValue: target) else {
                throw AutopilotRefusal.badTarget("no starter path named \(target)")
            }
            return .selectStarter(path)

        case .confirmStarter:
            return .confirmStarter

        case .openCard:
            let target = try requireTarget(command)
            guard let path = StarterPath(rawValue: target) else {
                throw AutopilotRefusal.badTarget("no starter path named \(target)")
            }
            return .selectCompanion(path)

        case .playWakeCall:
            return .playSonicIdentity

        case .stopWakeCall:
            return .stopSonicIdentity

        case .beginEncounter:
            return .beginEncounter

        case .encounterMove:
            let target = try requireTarget(command)
            guard let move = EncounterMove(rawValue: target) else {
                throw AutopilotRefusal.badTarget("no encounter move named \(target)")
            }
            return .encounterMove(move)

        case .leaveEncounter:
            return .leaveEncounter

        case .beginTraining:
            return .beginTraining

        case .trainingAnswer:
            let target = try requireTarget(command)
            guard let answer = TrainingAnswer(rawValue: target) else {
                throw AutopilotRefusal.badTarget("no training answer named \(target)")
            }
            return .trainingAnswer(answer)

        case .endTraining:
            return .endTraining

        case .setLeash:
            let target = try requireTarget(command)
            guard let leash = SelfSteerLeash(rawValue: target) else {
                throw AutopilotRefusal.badTarget("no leash named \(target)")
            }
            return .setLeash(leash)

        case .requestProposal:
            return .requestProposal

        case .openConfirmation:
            return .openConfirmation

        case .acknowledgeConfirmation:
            return .acknowledgeConfirmation(try requireTarget(command))

        case .approveAppend:
            return .approveAppend

        case .cancelAppend:
            return .cancelAppend

        case .resetSyntheticState:
            return .resetField

        case .fillPairingHost, .fillPairingCode, .submitSyntheticPair,
             .fillChatInput, .sendChat, .cancelChat, .snapshot, .inspectCompanion:
            return nil
        }
    }

    private func execute(_ command: AutopilotCommand) async throws {
        if let move = try gameCommand(for: command) {
            try await engine.apply(move)
            return
        }

        switch command.action {
        case .fillPairingHost:
            let value = try requireValue(command)
            // Validated exactly as the pairing screen validates it. Nothing
            // here fetches the address; it is only stored for the operator's
            // own host to be reached later.
            guard let url = URL(string: value),
                  url.scheme?.lowercased() == "https" || RappidLink.isLoopback(url) else {
                throw AutopilotRefusal.valueRejected("not a host address this app will talk to")
            }
            navigator.pairingHostText = value

        case .fillPairingCode:
            let value = try requireValue(command)
            guard (try? OneTimeCode(value)) != nil else {
                throw AutopilotRefusal.valueRejected("not a link code")
            }
            navigator.pairingCodeText = value

        case .submitSyntheticPair:
            // No credential can be supplied by a command: the grant is minted
            // locally from the code the operator's own host displayed.
            let link = try navigator.composedLink()
            navigator.pairingProblem = nil
            await model.pairSynthetically(with: link)
            engine.syncProposal()

        case .fillChatInput:
            navigator.chat.input = try requireValue(command)

        case .sendChat:
            guard let companion = model.ownedCompanion ?? model.selectedCompanion else {
                throw AutopilotRefusal.notApplicable("no companion is selected")
            }
            guard !navigator.chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AutopilotRefusal.notApplicable("there is nothing to send")
            }
            guard !navigator.chat.isReceiving else {
                throw AutopilotRefusal.notApplicable("a reply is already being composed")
            }
            navigator.chat.send(companion: companion)

        case .cancelChat:
            guard navigator.chat.isReceiving else {
                throw AutopilotRefusal.notApplicable("no reply is being composed")
            }
            navigator.chat.cancel()

        case .snapshot, .inspectCompanion:
            break

        default:
            throw AutopilotRefusal.unknownAction(command.action.rawValue)
        }
    }

    // MARK: Semantic state

    func snapshot() -> AutopilotState {
        let companion = model.selectedCompanion
        let stats = companion?.stats
        let game = engine.state

        return AutopilotState(
            screen: model.onboardingComplete ? navigator.selectedTab.rawValue : "onboarding",
            onboarding: model.onboardingComplete ? OnboardingStage.complete.rawValue : navigator.onboardingStage.rawValue,
            starter: model.chosenPath?.rawValue,
            stage: companion?.moltName,
            companion: companion?.displayName,
            rappidShortHex: companion?.identity.shortHex,
            frameHeight: stats?.frameHeight,
            weightComplete: stats?.weightComplete,
            weightBytes: stats?.totalWeightBytes,
            displayHeightMm: stats?.displayHeightMillimetres,
            displayHeightVersion: stats?.displayHeightVersion,
            dimensions: companion?.dimensions.count,
            traits: companion?.traitsMilli,
            origin: companion.map { $0.origin.isSynthetic ? "synthetic" : "paired" } ?? "none",
            pairing: pairingLabel,
            pairingHostFilled: !navigator.pairingHostText.isEmpty,
            pairingCodeFilled: !navigator.pairingCodeText.isEmpty,
            leash: model.leash.rawValue,
            proposal: navigator.proposal.map {
                AutopilotProposalState(
                    id: $0.id,
                    authoritative: $0.isAuthoritative,
                    appendable: $0.isAppendable,
                    dimension: $0.dimension,
                    predictedFrameHeight: $0.predictedFrameHeight
                )
            },
            confirmationVisible: navigator.confirmationVisible,
            confirmationAcknowledged: navigator.confirmationAcknowledged,
            appendRefusal: navigator.appendRefusal.map(AutopilotReceipt.truncatedError),
            wakeCall: wakeCallLabel,
            chatPhase: chatPhaseLabel,
            chatMessages: navigator.chat.messages.count,
            chatInputFilled: !navigator.chat.input.isEmpty,
            rosterCount: model.roster.count,
            attunement: game.attunement,
            encountersResolved: game.encountersResolved,
            drillsCompleted: game.drillsCompleted,
            encounter: game.encounter.map {
                AutopilotEncounterState(
                    id: $0.id,
                    kind: $0.kind,
                    strength: $0.strength,
                    step: $0.step,
                    stepsRemaining: $0.stepsRemaining,
                    attunement: $0.attunement,
                    revealedNotes: $0.revealedNotes,
                    phase: $0.phase.rawValue,
                    moves: $0.isOpen ? EncounterMove.allCases.map(\.rawValue) : []
                )
            },
            training: game.training.map {
                AutopilotTrainingState(
                    id: $0.id,
                    round: $0.round,
                    rounds: TrainingState.totalRounds,
                    correct: $0.correct,
                    phase: $0.phase.rawValue,
                    intervals: $0.intervals,
                    answers: $0.isOpen ? TrainingAnswer.allCases.map(\.rawValue) : []
                )
            },
            lastOutcome: game.lastOutcome.map(AutopilotReceipt.truncatedError),
            availableActions: availableActions
        )
    }

    /// What can be sent right now. Game moves come from the reducer itself, so
    /// this list can never disagree with what the rules accept.
    private var availableActions: [String] {
        var actions = engine.availableActions
        actions.append(contentsOf: ["snapshot", "inspectCompanion"])
        if !navigator.pairingHostText.isEmpty || !navigator.pairingCodeText.isEmpty || !model.pairing.isPaired {
            actions.append(contentsOf: ["fillPairingHost", "fillPairingCode"])
        }
        if !model.pairing.isPaired, !navigator.pairingCodeText.isEmpty {
            actions.append("submitSyntheticPair")
        }
        if model.onboardingComplete {
            actions.append("fillChatInput")
            if navigator.chat.isReceiving {
                actions.append("cancelChat")
            } else if !navigator.chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                actions.append("sendChat")
            }
        }
        return actions.sorted()
    }

    private var pairingLabel: String {
        switch model.pairing {
        case .unpaired: return "unpaired"
        case .synthetic: return "synthetic"
        case .paired: return "paired"
        }
    }

    private var wakeCallLabel: String {
        switch player.state {
        case .idle: return "idle"
        case .playing: return "playing"
        case .failed: return "failed"
        }
    }

    private var chatPhaseLabel: String {
        switch navigator.chat.buffer.phase {
        case .idle: return "idle"
        case .present: return "present"
        case .committed: return "committed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }
}
#endif
