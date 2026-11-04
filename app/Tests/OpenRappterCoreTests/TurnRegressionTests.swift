import XCTest
@testable import OpenRappterCore

extension CreatureStateMachineTests {
    func testAutomaticRetryNeverCancelsListeningOrDictation() {
        for stage in ["listening", "dictating"] {
            var state = CreatureStateMachine()
            let lookup = effectID(state.send(.findMind))
            state.send(.found(lookup, .failure(.unavailable)))
            let turn = startListening(&state, mode: .dictate)
            state.send(.partial(turn, "The port opens at 405 Main Street."))
            if stage == "dictating" {
                state.send(.keyUp(.dictate))
                XCTAssertEqual(state.send(.heard(turn, "Process a refund.")), [.dictate(turn, "Process a refund.")])
            }
            let before = state.presentation
            XCTAssertEqual(state.send(.wake(.retry(lookup))), [.wait(30, .retry(lookup))])
            XCTAssertEqual(state.presentation, before)
            if stage == "listening" {
                XCTAssertEqual(state.send(.keyUp(.dictate)), [.stopEars(turn)])
            } else {
                XCTAssertEqual(state.send(.dictated(turn, true)), [.wait(1, .rest(turn))])
            }
        }
    }

    func testAutomaticRetryPreservesUnansweredPermissionAndCallerCards() {
        var state = CreatureStateMachine()
        let lookup = effectID(state.send(.findMind))
        state.send(.found(lookup, .failure(.unavailable)))
        let turn = effectID(state.send(.keyDown(.ask)))
        state.send(.authorized(turn, .microphone))
        let permission = state.presentation.need
        XCTAssertEqual(state.send(.wake(.retry(lookup))), [.wait(30, .retry(lookup))])
        XCTAssertEqual(state.presentation.need, permission)
        let caller = Need(id: "caller", title: "Process JSON on port 405?", opts: [NeedOption(label: "Yes")], source: "doors")
        state.send(.needsChanged([caller]))
        state.send(.wake(.retry(lookup)))
        XCTAssertEqual(state.presentation.need, caller)
    }

    func testOldAutomaticRetryCannotCancelSignIn() {
        var state = CreatureStateMachine()
        let oldLookup = effectID(state.send(.findMind))
        state.send(.found(oldLookup, .failure(.unavailable)))
        let lookup = effectID(state.send(.signIn))
        let login = effectID(state.send(.found(lookup, .success(hungry))))
        state.send(.loginStarted(login, .success(code)))
        XCTAssertEqual(state.send(.wake(.retry(oldLookup))), [])
        XCTAssertEqual(state.send(.wake(.poll(login))), [.pollLogin(login)])
        XCTAssertTrue(state.presentation.line.contains(code.code))
    }

    func testReleaseBeforeDeniedPermissionStillOffersTheCorrectSetting() {
        for (permission, pane) in [(HearingPermission.microphone, "Microphone"), (.speech, "SpeechRecognition")] {
            var state = ready()
            let id = effectID(state.send(.keyDown(.ask)))
            state.send(.keyUp(.ask))
            XCTAssertEqual(state.send(.authorized(id, permission)), [])
            XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(
                permission == .microphone ? .microphone : .speech))
            XCTAssertTrue(state.presentation.need!.opts[0].action!.contains(pane))
            XCTAssertEqual(state.presentation.posture, .needsYou)
        }
    }

    func testReleaseBeforeGrantedPermissionSaysHowToTryAgainWithoutOpeningEars() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.keyUp(.ask))
        XCTAssertEqual(state.send(.authorized(id, .allowed)), [])
        XCTAssertEqual(state.presentation.line, "Ready. Hold Option and Space again to talk.")
        XCTAssertEqual(state.presentation.posture, .idle)
    }

    func testTransientPollFailureKeepsTheCodeAndCanStillFinish() {
        var (state, id) = signingIn()
        let before = state.presentation
        XCTAssertEqual(state.send(.loginPolled(id, .failure(.unavailable))), [.wait(2, .poll(id))])
        XCTAssertEqual(state.presentation, before)
        XCTAssertEqual(state.send(.loginPolled(id, .success(LoginProgress(status: "ok")))), [.confirmLogin(id)])
        state.send(.loginConfirmed(id, .success(fed)))
        XCTAssertFalse(state.presentation.hungry)
    }

    func testPollFailureBudgetIsBoundedAndResetsAfterAnAnswer() {
        var (state, id) = signingIn()
        for _ in 0..<2 {
            for _ in 0..<9 {
                XCTAssertEqual(state.send(.loginPolled(id, .failure(.unavailable))), [.wait(2, .poll(id))])
                XCTAssertTrue(state.presentation.line.contains(code.code))
            }
            state.send(.loginPolled(id, .success(LoginProgress(status: "pending"))))
        }
        for _ in 0..<9 { state.send(.loginPolled(id, .failure(.unavailable))) }
        let failed = state.send(.loginPolled(id, .failure(.unavailable)))
        XCTAssertTrue(failed.contains(.cancel(.login)))
        XCTAssertTrue(failed.contains(.restoreClipboard))
        XCTAssertTrue(state.presentation.line.contains("couldn't check"))
        XCTAssertEqual(state.send(.wake(.poll(id))), [])
    }

    func testLaterOnPermissionOrHelpDoesNotCancelSignIn() {
        for permission in [true, false] {
            var (state, login) = signingIn()
            if permission {
                let id = effectID(state.send(.keyDown(.ask)))
                state.send(.authorized(id, .speech))
            } else { state.send(.showHelp) }
            let card = state.presentation.need!
            XCTAssertNotEqual(card.id, "creature:signing-in")
            XCTAssertEqual(state.send(.later(card)), [])
            XCTAssertEqual(state.send(.wake(.poll(login))), [.pollLogin(login)])
            XCTAssertTrue(state.presentation.line.contains(code.code))
        }
    }

    func testLaterOnSignInCardItselfStillCancelsAndRestoresClipboard() {
        var (state, login) = signingIn()
        let effects = state.send(.later(state.presentation.need!))
        XCTAssertTrue(effects.contains(.cancel(.login)))
        XCTAssertTrue(effects.contains(.restoreClipboard))
        XCTAssertEqual(state.send(.wake(.poll(login))), [])
    }

    func testTransientChatFailureDoesNotMakeTheNextQuestionLoseItsMind() {
        var state = ready()
        let first = effectID(state.send(.submit(.ask, "First")))
        state.send(.replied(first, .failure(.unavailable)))
        let failure = state.presentation.need!
        XCTAssertEqual(failure.opts[0].action, "creature:find")
        state.send(.later(failure))
        let next = state.send(.submit(.ask, "Second"))
        guard case .chat(_, let text, _, _) = next.last else { return XCTFail("The mind must remain available for another question") }
        XCTAssertTrue(text.hasPrefix("Second\n\n"))
    }

    func testTranscriptMindTextVoiceAndHistoryAreVerbatim() {
        var state = ready()
        let id = startListening(&state)
        let question = "What process opens the port at 405 Main Street? https://portseattle.org"
        state.send(.partial(id, question))
        XCTAssertEqual(state.presentation.line, question)
        state.send(.keyUp(.ask))
        let effects = state.send(.heard(id, question))
        XCTAssertEqual(state.presentation.line, question)
        guard case .chat(_, let sent, _, _) = effects.first else { return XCTFail("Expected a question") }
        XCTAssertTrue(sent.hasPrefix(question + "\n\n"))
        let answer = "Process a refund at the Port of Seattle. JSON token: https://portseattle.org/405"
        let voice = "The port opens at 6. Go to 405 Main Street."
        XCTAssertEqual(state.send(.replied(id, .success(MindReply(
            text: answer, senses: ["voice": voice], sessionId: nil, raw: answer)))), [.speak(id, voice)])
        XCTAssertEqual(state.presentation.line, answer)
        XCTAssertEqual(state.history.map { $0["content"]! }, [question, answer])
    }

    func testCallerCardAndSelectedOptionRemainVerbatim() {
        var state = ready()
        let need = Need(id: "hook", title: "Process JSON from https://example.com:405?",
                        ctx: "Keep the kernel token in this socket.", opts: [NeedOption(label: "Process JSON", action: "approve")],
                        source: "claude-code")
        state.send(.needsChanged([need]))
        XCTAssertEqual(state.presentation.need, need)
        XCTAssertEqual(state.presentation.line, need.title)
        XCTAssertEqual(state.send(.answer(state.presentation.need!, state.presentation.need!.opts[0])), [.answer(need, need.opts[0])])
    }

    func testBusyHotkeyGivesFeedbackWithoutOverlappingOrChangingHistory() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "The original question")))
        XCTAssertEqual(state.send(.keyDown(.ask)), [])
        XCTAssertEqual(state.presentation.line, "Still thinking about your last question.")
        XCTAssertEqual(state.presentation.posture, .thinking)
        state.send(.replied(id, .success(reply())))
        XCTAssertEqual(state.history.first?["content"], "The original question")
    }

    func testFailedLoginDismissalStillExplainsHungerNotMissingMind() {
        for progress in [LoginProgress(status: "expired"), LoginProgress(status: "error", error: "access_denied"),
                         LoginProgress(status: "error", error: "unfamiliar")] {
            var (state, id) = signingIn()
            state.send(.loginPolled(id, .success(progress)))
            state.send(.later(state.presentation.need!))
            state.send(.submit(.ask, "Hello"))
            XCTAssertTrue(state.presentation.hungry)
            XCTAssertTrue(state.presentation.line.contains("I can't think yet"))
            XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:sign-in")
        }
    }

    func testLoginSetupSuccessConfirmsBothReturnsAndHasDismissal() {
        var state = ready()
        let id = effectID(state.send(.installAtLogin))
        XCTAssertEqual(state.presentation.line, "Getting my mind ready for when you sign in to this Mac.")
        state.send(.installedAtLogin(id, .success(.installed)))
        XCTAssertTrue(state.presentation.line.contains("My mind will be ready"))
        XCTAssertTrue(state.presentation.line.contains("I'll come back"))
        let card = state.presentation.need!
        XCTAssertEqual(card.opts[0].label, "Got it")
        state.send(.answer(card, card.opts[0]))
        XCTAssertEqual(state.presentation.posture, .idle)
    }

    func testStartupChangesDoNotInterruptAnActiveTurnOrSignIn() {
        var (state, login) = signingIn()
        let turn = startListening(&state, mode: .dictate)
        XCTAssertEqual(state.send(.stopAtLogin), [.cancel(.retry), .stopAtLogin])
        state.send(.stoppedAtLogin(true))
        let setup = effectID(state.send(.installAtLogin))
        state.send(.installedAtLogin(setup, .success(.installed)))
        XCTAssertEqual(state.presentation.posture, .listening)
        XCTAssertEqual(state.send(.wake(.poll(login))), [.pollLogin(login)])
        XCTAssertEqual(state.send(.keyUp(.dictate)), [.stopEars(turn)])
    }
}

extension MindClientTests {
    func testCreatureChatTimeoutIsShorterThanTwoMinutes() {
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:1")!)
        XCTAssertEqual(client.session.configuration.timeoutIntervalForRequest, 45)
        XCTAssertEqual(client.session.configuration.timeoutIntervalForResource, 45)
    }
}

extension DoorWordsTests {
    func testCallerReasonAndNameAreNotRewrittenAsCreatureCopy() {
        let why = "Process JSON for the Port of Seattle at 405 Main Street: https://portseattle.org"
        let caller = DoorCaller(name: "Port", pid: 1, program: "/secret/program", why: why)
        let need = DoorWords.approval(caller, door: "browser.open", id: "request", now: 1)
        XCTAssertEqual(need.title, "Port wants to open a page.")
        XCTAssertEqual(need.ctx, why + "\nChoose Allow once to let it, or No to stop it.")
    }
}

extension VoiceTests {
    func testActualUtterancePreservesTheMindsWords() async {
        let words = "Process JSON at the Port of Seattle, 405 Main Street. https://portseattle.org"
        let spoken = expectation(description: "Utterance delivered")
        let voice = Voice(output: {
            XCTAssertEqual($0.speechString, words)
            spoken.fulfill()
        }, stop: {})
        let task = Task { await voice.speak(words) }
        await fulfillment(of: [spoken], timeout: 2)
        voice.stop()
        await task.value
    }
}

extension NeedsTests {
    func testCreatureStreamBindingPreservesForeignUpdates() throws {
        let queue = NeedsQueue(dir: try testDirectory(self))
        let model = CreatureModel()
        model.followStream(queue)
        let note = Need(id: "update", title: "Process JSON from https://portseattle.org at 405 Main Street.",
                        ctx: "The kernel token uses a socket.", opts: [NeedOption(label: "OK")], source: "twin")
        queue.add(note)
        XCTAssertEqual(model.stream, [note])
        XCTAssertNil(queue.top)
    }
}
