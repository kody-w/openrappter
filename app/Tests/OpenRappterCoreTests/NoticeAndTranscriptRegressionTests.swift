import XCTest
@testable import OpenRappterCore

extension CreatureStateMachineTests {
    func testRequiredMindCardsSurviveNoticeDeliveryAndKeepTheirActions() {
        for scenario in ["sign-in", "missing", "tools", "retry", "failed-sign-in"] {
            var state = ready()
            let timeout = noticeWake(state.send(.showHelp))
            let effects: [CreatureEffect]
            let action: String
            switch scenario {
            case "retry":
                let ask = effectID(state.send(.submit(.ask, "Hello")))
                effects = state.send(.replied(ask, .failure(.unavailable)))
                action = "creature:find"
            default:
                let find = effectID(state.send(.findMind))
                switch scenario {
                case "sign-in", "failed-sign-in":
                    effects = state.send(.found(find, .success(hungry)))
                    action = "creature:sign-in"
                case "tools":
                    effects = state.send(.found(find, .failure(.toolsMissing)))
                    action = "creature:install-tools"
                default:
                    effects = state.send(.found(find, .failure(.unavailable)))
                    action = "creature:find"
                }
            }
            if scenario == "failed-sign-in" {
                let login = effectID(state.send(.signIn))
                state.send(.loginStarted(login, .failure(.unavailable)))
            }
            XCTAssertFalse(effects.contains { if case .wait(_, .notice) = $0 { return true }; return false })
            let card = state.presentation.need
            state.send(.wake(timeout))
            XCTAssertTrue(state.presentation.expanded, scenario)
            XCTAssertEqual(state.presentation.posture, .needsYou, scenario)
            XCTAssertEqual(state.presentation.need, card, scenario)
            XCTAssertEqual(state.presentation.need?.opts.first?.action, action, scenario)
            guard let card else { XCTFail("Missing recovery card: \(scenario)"); continue }
            let recovery = state.send(.answer(card, card.opts[0]))
            XCTAssertTrue(recovery.contains {
                switch $0 {
                case .findMind: return action == "creature:find" || action == "creature:sign-in"
                case .startLogin: return action == "creature:sign-in"
                case .installTools: return action == "creature:install-tools"
                default: return false
                }
            }, scenario)
        }
    }

    func testPendingKeepCardsSurviveNoticeDeliveryAndStillFinishTheRequest() {
        for failure in [CreatureFailure.toolsMissing, .unavailable] {
            var state = ready()
            let timeout = noticeWake(state.send(.showHelp))
            let setup = effectID(state.send(.installAtLogin))
            let failed = state.send(.installedAtLogin(setup, .failure(failure)))
            XCTAssertFalse(failed.contains { if case .wait(_, .notice) = $0 { return true }; return false })
            let card = state.presentation.need!
            state.send(.wake(timeout))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertEqual(state.presentation.need, card)
            if failure == .toolsMissing {
                XCTAssertEqual(state.send(.answer(card, card.opts[0])), [.installTools])
                state.send(.wake(timeout))
                XCTAssertTrue(state.presentation.expanded)
                XCTAssertEqual(state.presentation.need, card)
            }
            let action = failure == .toolsMissing ? "creature:find" : "creature:install-login"
            let option = card.opts.first { $0.action == action }!
            let resumed = state.send(.answer(card, option))
            let keep = effectID(resumed)
            XCTAssertTrue(resumed.contains(.installAtLogin(keep)))
            let confirmation = state.send(.installedAtLogin(keep, .success(.installed)))
            XCTAssertTrue(state.presentation.line.contains("I'll come back"))
            state.send(.wake(noticeWake(confirmation)))
            XCTAssertFalse(state.presentation.expanded, "A successful Keep confirmation is still informational")
        }
    }

    func testDeferredActionableStartupCardIsNotLostWhenALineExpires() {
        for result in [Result<LoginItemResult, CreatureFailure>.failure(.toolsMissing),
                       .failure(.unavailable), .success(.moveRequired)] {
            var state = ready()
            let timeout = noticeWake(state.send(.showInput))
            state.send(.checkedLoginItem(result))
            XCTAssertNil(state.presentation.need)
            state.send(.wake(timeout))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertEqual(state.presentation.posture, .needsYou)
            XCTAssertNotNil(state.presentation.need?.opts.first?.action)
            XCTAssertNotEqual(state.presentation.need?.opts.first?.action, "creature:dismiss")
            let card = state.presentation.need
            state.send(.wake(timeout))
            XCTAssertEqual(state.presentation.need, card)
            XCTAssertTrue(state.presentation.expanded)
        }
    }

    func testExpiringHelpCannotDismissTheUnderlyingSignInOrMissingMind() {
        for health in [Optional(hungry), nil] {
            var state = ready()
            let find = effectID(state.send(.findMind))
            if let health { state.send(.found(find, .success(health))) }
            else { state.send(.found(find, .failure(.unavailable))) }
            let required = state.presentation.need
            let timeout = noticeWake(state.send(.showHelp))
            XCTAssertEqual(state.presentation.need?.id, "creature:help")
            state.send(.wake(timeout))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertEqual(state.presentation.need, required)
            XCTAssertEqual(state.presentation.need?.opts.first?.action,
                           health == nil ? "creature:find" : "creature:sign-in")
        }
    }
}

extension SpeechRecognitionRegressionTests {
    func testRecognitionErrorKeepsPreviouslyHeardWordsThroughTheRealAdapter() async throws {
        for mode in [TalkMode.ask, .dictate, .screen] {
            let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in },
                                            start: {}, stop: {}, remove: {})
            var receive: ((String?, Bool, Error?) -> Void)?
            let ears = Ears(capture: capture, available: { true }, recognize: { _, callback in
                receive = callback
                return {}
            })
            let dir = try testDirectory(self)
            let effects = MacCreatureEffects(runner: MindRunner(kernelDir: dir), needs: NeedsQueue(dir: dir), ears: ears,
                                             voice: Voice(output: { _ in }, stop: {}))
            var state = CreatureStateMachine()
            let lookup = state.send(.findMind)
            guard case .findMind(let found) = lookup.last else { return XCTFail("Lookup") }
            state.send(.found(found, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
            guard case .authorize(let id) = state.send(.keyDown(mode)).last else { return XCTFail("Authorize") }
            state.send(.authorized(id, .allowed))
            if let started = await effects.perform(.startEars(id)) { state.send(started) }
            let partial = expectation(description: "The owner sees the recognized words")
            ears.onPartial = {
                state.send(.partial(id, $0))
                partial.fulfill()
            }
            let words = "The owner's exact words"
            receive?(words, false, nil)
            await fulfillment(of: [partial], timeout: 2)
            XCTAssertEqual(state.presentation.line, words)
            state.send(.keyUp(mode))
            receive?(nil, false, NSError(domain: "Speech", code: 1))
            let event = await effects.perform(.stopEars(id))
            XCTAssertEqual(event, .heard(id, words))
            let work = state.send(try XCTUnwrap(event))
            XCTAssertTrue(work.contains {
                switch $0 {
                case .chat(_, let text, _, _): return mode == .ask && text.hasPrefix(words + "\n\n")
                case .dictate(_, let text): return mode == .dictate && text == words
                case .readScreen(_, let text): return mode == .screen && text == words
                default: return false
                }
            })
        }
    }

    func testRecognitionResultAccompanyingAnErrorIsStillUsable() async throws {
        let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in }, start: {}, stop: {}, remove: {})
        var receive: ((String?, Bool, Error?) -> Void)?
        let ears = Ears(capture: capture, available: { true }, recognize: { _, callback in
            receive = callback
            return {}
        })
        try ears.start()
        receive?("  Keep these words. \n", false, NSError(domain: "Speech", code: 1))
        let result = await ears.stop()
        XCTAssertEqual(result, .success("Keep these words."))
        try ears.start()
        receive?(" \n ", false, NSError(domain: "Speech", code: 1))
        let empty = await ears.stop()
        XCTAssertEqual(empty, .failure(.recognitionFailed), "A genuine failure without words must not become silence")
    }

    func testEmptyErrorResultCannotEraseAnEarlierTranscriptOrLeakIntoNextCapture() async throws {
        let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in }, start: {}, stop: {}, remove: {})
        var receive: ((String?, Bool, Error?) -> Void)?
        let ears = Ears(capture: capture, available: { true }, recognize: { _, callback in
            receive = callback
            return {}
        })
        try ears.start()
        let partial = expectation(description: "Partial transcript saved")
        ears.onPartial = { _ in partial.fulfill() }
        receive?("Already heard", false, nil)
        await fulfillment(of: [partial], timeout: 2)
        let oldReceive = receive
        receive?("", false, NSError(domain: "Speech", code: 1))
        let saved = await ears.stop()
        XCTAssertEqual(saved, .success("Already heard"))
        ears.onPartial = nil
        try ears.start()
        oldReceive?("Stale words", true, nil)
        receive?(nil, false, NSError(domain: "Speech", code: 1))
        let fresh = await ears.stop()
        XCTAssertEqual(fresh, .failure(.recognitionFailed))
    }
}
