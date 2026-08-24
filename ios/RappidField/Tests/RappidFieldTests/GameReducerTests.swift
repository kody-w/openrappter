import XCTest
@testable import RappidField

/// The rules, tested where they live: one pure function, no view, no engine,
/// no network.
final class GameReducerTests: XCTestCase {
    private let rappid = SyntheticField.identity(for: .canopy).description
    private var motif: [Int] {
        SyntheticField.signature(for: .canopy).prompt.map(\.pitch)
    }

    private func playingContext(
        leash: SelfSteerLeash = .propose,
        hasProposal: Bool = false,
        confirmationVisible: Bool = false,
        acknowledged: Bool = false,
        playing: Bool = false
    ) -> GameContext {
        GameContext(
            onboardingComplete: true,
            chosenPath: .canopy,
            onboardingSelection: .canopy,
            companionRappid: rappid,
            motif: motif,
            rosterPaths: StarterPath.allCases,
            leash: leash,
            hasProposal: hasProposal,
            proposalID: hasProposal ? "proposal-test" : nil,
            confirmationVisible: confirmationVisible,
            confirmationAcknowledged: acknowledged,
            isPlayingSonic: playing
        )
    }

    private func reduce(
        _ command: GameCommand,
        state: GameState = GameState(),
        context: GameContext? = nil
    ) throws -> GameOutcome {
        try GameReducer.reduce(state: state, command: command, context: context ?? playingContext())
    }

    // MARK: Encounters

    func testEncountersAreDeterministicForTheSameCompanionAndIndex() {
        let first = GameRules.makeEncounter(rappid: rappid, index: 0, motif: motif)
        let second = GameRules.makeEncounter(rappid: rappid, index: 0, motif: motif)
        XCTAssertEqual(first, second)

        let later = GameRules.makeEncounter(rappid: rappid, index: 1, motif: motif)
        XCTAssertNotEqual(first.id, later.id)

        let otherCompanion = GameRules.makeEncounter(
            rappid: SyntheticField.identity(for: .forge).description,
            index: 0,
            motif: SyntheticField.signature(for: .forge).prompt.map(\.pitch)
        )
        XCTAssertNotEqual(first.id, otherCompanion.id)
        XCTAssertTrue(GameRules.encounterKinds.contains(first.kind))
        XCTAssertTrue((1...3).contains(first.strength))
    }

    func testListeningIsSafeAndApproachingEarlyIsNot() throws {
        let opened = try reduce(.beginEncounter).state
        let encounter = try XCTUnwrap(opened.encounter)
        XCTAssertTrue(encounter.isOpen)
        XCTAssertEqual(encounter.revealedNotes, 0)

        let listened = try reduce(.encounterMove(.listen), state: opened).state
        let afterListen = try XCTUnwrap(listened.encounter)
        XCTAssertEqual(afterListen.revealedNotes, 1)
        XCTAssertGreaterThan(afterListen.attunement, encounter.attunement)

        let rushed = try reduce(.encounterMove(.approach), state: opened).state
        let afterRush = try XCTUnwrap(rushed.encounter)
        XCTAssertLessThan(afterRush.attunement, encounter.attunement, "closing before you have heard it costs")
    }

    func testAnEncounterCanBeWonByListeningFirst() throws {
        var state = try reduce(.beginEncounter).state
        state = try reduce(.encounterMove(.listen), state: state).state
        state = try reduce(.encounterMove(.listen), state: state).state
        state = try reduce(.encounterMove(.approach), state: state).state
        let encounter = try XCTUnwrap(state.encounter)

        if encounter.phase == .attuned {
            XCTAssertEqual(state.encountersResolved, 1)
            XCTAssertEqual(state.attunement, 20)
        } else {
            // A strong signal needs the fourth step; take it and it lands.
            state = try reduce(.encounterMove(.approach), state: state).state
            let finished = try XCTUnwrap(state.encounter)
            XCTAssertFalse(finished.isOpen, "an encounter always resolves within \(EncounterState.maxSteps) steps")
        }
    }

    func testWithdrawEndsAnEncounterWithoutGainOrLoss() throws {
        let opened = try reduce(.beginEncounter).state
        let left = try reduce(.encounterMove(.withdraw), state: opened).state
        XCTAssertEqual(left.encounter?.phase, .withdrawn)
        XCTAssertEqual(left.encountersResolved, 0)
        XCTAssertEqual(left.attunement, 0)
    }

    func testAnEncounterAlwaysResolvesWithinItsSteps() throws {
        for move in EncounterMove.allCases where move != .withdraw {
            var state = try reduce(.beginEncounter).state
            for _ in 0..<EncounterState.maxSteps {
                guard state.encounter?.isOpen == true else { break }
                state = try reduce(.encounterMove(move), state: state).state
            }
            XCTAssertEqual(state.encounter?.isOpen, false, "\(move) must terminate")
        }
    }

    func testASecondEncounterIsRefusedWhileOneIsOpen() throws {
        let opened = try reduce(.beginEncounter).state
        XCTAssertThrowsError(try reduce(.beginEncounter, state: opened)) {
            XCTAssertEqual($0 as? GameRefusal, .encounterAlreadyOpen)
        }
        XCTAssertThrowsError(try reduce(.encounterMove(.listen))) {
            XCTAssertEqual($0 as? GameRefusal, .noOpenEncounter)
        }
    }

    // MARK: Training

    func testTheDrillAnswerFollowsThePublishedShape() {
        XCTAssertEqual(GameRules.expectedAnswer(for: [60, 62, 64, 67]), .extend)
        XCTAssertEqual(GameRules.expectedAnswer(for: [67, 64, 62, 60]), .invert)
        XCTAssertEqual(GameRules.expectedAnswer(for: [60, 62, 62, 60]), .echo)
    }

    func testADrillCanBePlayedFromItsPublishedIntervals() throws {
        var state = try reduce(.beginTraining).state
        XCTAssertEqual(state.training?.round, 0)

        for _ in 0..<TrainingState.totalRounds {
            let drill = try XCTUnwrap(state.training)
            // Exactly what an agent does with the receipt: read the shape.
            let shape = drill.intervals.reduce(0, +)
            let answer: TrainingAnswer = shape > 0 ? .extend : (shape < 0 ? .invert : .echo)
            state = try reduce(.trainingAnswer(answer), state: state).state
        }

        let finished = try XCTUnwrap(state.training)
        XCTAssertEqual(finished.phase, .complete)
        XCTAssertEqual(finished.correct, TrainingState.totalRounds, "a played drill is a won drill")
        XCTAssertEqual(state.drillsCompleted, 1)
        XCTAssertEqual(state.attunement, TrainingState.totalRounds * 5)
    }

    func testAWrongAnswerStillAdvancesTheDrill() throws {
        var state = try reduce(.beginTraining).state
        let drill = try XCTUnwrap(state.training)
        let expected = GameRules.expectedAnswer(for: drill.prompt)
        let wrong = TrainingAnswer.allCases.first { $0 != expected }!
        state = try reduce(.trainingAnswer(wrong), state: state).state
        XCTAssertEqual(state.training?.round, 1)
        XCTAssertEqual(state.training?.correct, 0)
    }

    func testTrainingRefusesWhenThereIsNoDrill() {
        XCTAssertThrowsError(try reduce(.trainingAnswer(.echo))) {
            XCTAssertEqual($0 as? GameRefusal, .noOpenTraining)
        }
        XCTAssertThrowsError(try reduce(.endTraining)) {
            XCTAssertEqual($0 as? GameRefusal, .noOpenTraining)
        }
    }

    // MARK: Gates the rules keep

    func testNothingIsPlayableBeforeAStarterIsChosen() {
        let context = GameContext(onboardingComplete: false, onboardingSelection: nil)
        for command in [GameCommand.openScreen(.growth), .beginEncounter, .beginTraining, .requestProposal, .resetField] {
            XCTAssertThrowsError(try reduce(command, context: context), "\(command.name) must wait for onboarding")
        }
        XCTAssertNoThrow(try reduce(.selectStarter(.forge), context: context))
        XCTAssertThrowsError(try reduce(.confirmStarter, context: context)) {
            XCTAssertEqual($0 as? GameRefusal, .starterNotSelected)
        }
    }

    func testObserveLeashRefusesToRead() {
        XCTAssertThrowsError(try reduce(.requestProposal, context: playingContext(leash: .observe))) {
            XCTAssertEqual($0 as? GameRefusal, .leashObserves(.observe))
        }
        XCTAssertNoThrow(try reduce(.requestProposal, context: playingContext(leash: .runApproved)))
    }

    func testApprovalNeedsTheSheetAndTheAcknowledgement() throws {
        XCTAssertThrowsError(try reduce(.approveAppend)) {
            XCTAssertEqual($0 as? GameRefusal, .confirmationNotOpen)
        }
        XCTAssertThrowsError(try reduce(.approveAppend, context: playingContext(confirmationVisible: true))) {
            XCTAssertEqual($0 as? GameRefusal, .confirmationNotAcknowledged)
        }
        let outcome = try reduce(
            .approveAppend,
            context: playingContext(confirmationVisible: true, acknowledged: true)
        )
        XCTAssertEqual(outcome.effects, [.performAppend], "approval only ever asks for the append; the policy decides")
    }

    func testPlaybackIsNeverDoubleStartedOrStoppedWhenSilent() {
        XCTAssertNoThrow(try reduce(.playSonicIdentity))
        XCTAssertThrowsError(try reduce(.playSonicIdentity, context: playingContext(playing: true))) {
            XCTAssertEqual($0 as? GameRefusal, .alreadyPlaying)
        }
        XCTAssertThrowsError(try reduce(.stopSonicIdentity)) {
            XCTAssertEqual($0 as? GameRefusal, .nothingIsPlaying)
        }
        XCTAssertNoThrow(try reduce(.stopSonicIdentity, context: playingContext(playing: true)))
    }

    func testResetClearsEveryTraceOfPlay() throws {
        var state = try reduce(.beginEncounter).state
        state = try reduce(.encounterMove(.listen), state: state).state
        state = try reduce(.beginTraining, state: state).state
        XCTAssertNotNil(state.encounter)

        let outcome = try reduce(.resetField, state: state)
        XCTAssertEqual(outcome.state, GameState())
        XCTAssertTrue(outcome.effects.contains(.resetField))
    }

    // MARK: The advertised action list

    /// The list an agent reads is produced by the same function that refuses,
    /// so it cannot advertise a move the rules would reject.
    func testAvailableCommandsAgreeWithWhatTheReducerAccepts() throws {
        let states: [(GameState, GameContext)] = [
            (GameState(), GameContext(onboardingComplete: false)),
            (GameState(), playingContext()),
            (GameState(), playingContext(leash: .observe)),
            (try reduce(.beginEncounter).state, playingContext()),
            (try reduce(.beginTraining).state, playingContext()),
            (GameState(), playingContext(hasProposal: true, confirmationVisible: true, acknowledged: true)),
            (GameState(), playingContext(playing: true)),
        ]

        for (state, context) in states {
            let available = Set(GameReducer.availableCommands(state: state, context: context))
            for command in GameCommand.representatives(proposalID: context.proposalID) {
                let accepted = (try? GameReducer.reduce(state: state, command: command, context: context)) != nil
                if accepted {
                    XCTAssertTrue(available.contains(command.name), "\(command.name) was accepted but not advertised")
                } else {
                    XCTAssertFalse(available.contains(command.name), "\(command.name) was advertised but refused")
                }
            }
            XCTAssertEqual(available.count, Set(available).count)
        }
    }

    func testAvailableCommandsMoveWithTheGame() throws {
        let idle = GameReducer.availableCommands(state: GameState(), context: playingContext())
        XCTAssertTrue(idle.contains("beginEncounter"))
        XCTAssertFalse(idle.contains("encounterMove"))
        XCTAssertFalse(idle.contains("leaveEncounter"))

        let open = try reduce(.beginEncounter).state
        let during = GameReducer.availableCommands(state: open, context: playingContext())
        XCTAssertTrue(during.contains("encounterMove"))
        XCTAssertTrue(during.contains("leaveEncounter"))
        XCTAssertFalse(during.contains("beginEncounter"))
    }

    func testRulesAreAPureFunctionOfStateAndContext() throws {
        let before = try reduce(.beginEncounter).state
        let firstRun = try GameReducer.reduce(state: before, command: .encounterMove(.listen), context: playingContext())
        let secondRun = try GameReducer.reduce(state: before, command: .encounterMove(.listen), context: playingContext())
        XCTAssertEqual(firstRun, secondRun)
        XCTAssertEqual(before.encounter?.revealedNotes, 0, "the input state is never mutated")
    }

    // MARK: Play feeds the reading, and never the organism

    func testProgressChangesTheProposalWithoutTouchingIdentity() {
        let companion = SyntheticField.companion(for: .canopy)
        let cold = ProposalEngine.proposal(for: companion, progress: .initial)
        let played = ProposalEngine.proposal(
            for: companion,
            progress: GameProgress(attunement: 40, encountersResolved: 2, drillsCompleted: 1)
        )

        XCTAssertNotEqual(cold.id, played.id, "a companion you have played with reads differently")
        XCTAssertFalse(cold.isAuthoritative)
        XCTAssertFalse(played.isAuthoritative)
        XCTAssertEqual(cold.rappid, played.rappid, "playing never re-mints an identity")
        XCTAssertEqual(companion.frameHeight, SyntheticField.companion(for: .canopy).frameHeight)
        XCTAssertTrue(played.evidence.contains { $0.contains("attunement 40") })
    }
}
