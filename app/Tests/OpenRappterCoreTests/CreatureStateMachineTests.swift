import XCTest
@testable import OpenRappterCore

final class CreatureStateMachineTests: XCTestCase {
    let fed = MindHealth(status: "ok", version: "test", model: "fake", agentCount: 1)
    let hungry = MindHealth(status: "unauthenticated", version: "test", model: "fake", agentCount: 1)
    let code = LoginCode(code: "ABCD-1234", url: URL(string: "https://github.com/login/device")!)

    func effectID(_ effects: [CreatureEffect], file: StaticString = #filePath, line: UInt = #line) -> Int {
        for effect in effects {
            switch effect {
            case .findMind(let id), .startLogin(let id), .authorize(let id), .startEars(let id),
                 .stopEars(let id), .pollLogin(let id), .confirmLogin(let id), .installAtLogin(let id): return id
            case .chat(let id, _, _, _), .readScreen(let id, _), .dictate(let id, _), .speak(let id, _): return id
            default: continue
            }
        }
        XCTFail("No work effect in \(effects)", file: file, line: line)
        return -1
    }

    func ready(_ health: MindHealth? = nil) -> CreatureStateMachine {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        state.send(.found(id, .success(health ?? fed)))
        return state
    }

    func signingIn() -> (CreatureStateMachine, Int) {
        var state = ready(hungry)
        let id = effectID(state.send(.signIn))
        state.send(.loginStarted(id, .success(code)))
        return (state, id)
    }

    func startListening(_ state: inout CreatureStateMachine, mode: TalkMode = .ask) -> Int {
        let id = effectID(state.send(.keyDown(mode)))
        XCTAssertEqual(state.send(.authorized(id, .allowed)), [.startEars(id)])
        state.send(.earsStarted(id, true))
        return id
    }

    func reply(_ text: String = "Hello.") -> MindReply {
        MindReply(text: text, senses: ["voice": "Hi."], sessionId: "conversation", raw: text)
    }

    func testSignInWithoutMindFindsBeforeStarting() {
        var state = CreatureStateMachine()
        let find = effectID(state.send(.signIn))
        XCTAssertEqual(state.presentation.posture, .thinking)
        XCTAssertEqual(state.presentation.line, "Finding my mind.")
        let login = effectID(state.send(.found(find, .success(hungry))))
        XCTAssertEqual(state.send(.loginStarted(login, .success(code))),
                       [.showCode(code), .wait(2, .poll(login))])
        XCTAssertTrue(state.presentation.line.contains(code.code))
    }

    func testOnlySuccessfulPollCanFeed() {
        var (state, id) = signingIn()
        XCTAssertEqual(state.send(.loginConfirmed(id, .success(fed))), [])
        let pending = state.send(.loginPolled(id, .success(LoginProgress(status: "pending"))))
        XCTAssertEqual(pending, [.wait(2, .poll(id))])
        XCTAssertTrue(state.presentation.hungry)
        XCTAssertTrue(state.presentation.line.contains(code.code))
        XCTAssertEqual(state.send(.loginPolled(id, .success(LoginProgress(status: "success")))), [.confirmLogin(id)])
        state.send(.loginConfirmed(id, .success(MindHealth(status: "ok", version: "", model: "",
                                                          agentCount: 0, copilot: "no_access"))))
        XCTAssertTrue(state.presentation.hungry)
        XCTAssertTrue(state.presentation.line.contains("Enable Copilot"))

        (state, id) = signingIn()
        state.send(.loginPolled(id, .success(LoginProgress(status: "ok"))))
        XCTAssertTrue(state.presentation.hungry, "A successful poll still needs a confirming health read")
        let done = state.send(.loginConfirmed(id, .success(fed)))
        XCTAssertTrue(done.contains(.restoreClipboard))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertFalse(state.presentation.hungry)
    }

    func testLoginFailuresHaveDistinctNextSteps() {
        for (progress, words) in [
            (LoginProgress(status: "expired"), "expired"),
            (LoginProgress(status: "error", error: "Login failed: access_denied"), "cancelled"),
            (LoginProgress(status: "error", error: "NO_COPILOT_ACCESS:owner"), "Enable Copilot"),
            (LoginProgress(status: "error", error: "Something unfamiliar"), "GitHub couldn't finish"),
        ] {
            var (state, id) = signingIn()
            let effects = state.send(.loginPolled(id, .success(progress)))
            XCTAssertTrue(state.presentation.line.contains(words), state.presentation.line)
            XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:sign-in")
            XCTAssertTrue(effects.contains(.restoreClipboard))
        }
    }

    func testLostLoginRestartsOnceInsteadOfCallingItExpired() {
        var (state, id) = signingIn()
        let lost = LoginProgress(status: "expired", error: "No login in progress")
        XCTAssertEqual(state.send(.loginPolled(id, .success(lost))), [.restoreClipboard, .startLogin(id)])
        state.send(.loginStarted(id, .success(code)))
        XCTAssertTrue(state.send(.loginPolled(id, .success(lost))).contains(.restoreClipboard))
        XCTAssertTrue(state.presentation.line.contains("expired"))
    }

    func testNeedsAppearWithoutMindAndImmediatelyAfterSignIn() {
        let cards = [
            Need(id: "door", title: "Beam wants to add a reminder.", opts: [NeedOption(label: "Allow once")], source: "doors"),
            Need(id: "local", title: "Let me hear you.", opts: [NeedOption(label: "Open the setting")], source: "openrappter"),
            Need(id: "helper", title: "May I edit this?", opts: [NeedOption(label: "Yes")], source: "claude-code"),
        ]
        for health in [hungry, fed] {
            var state = ready(health)
            for card in cards {
                state.send(.needsChanged([card]))
                XCTAssertEqual(state.presentation.need?.id, card.id)
            }
        }
        var state = CreatureStateMachine()
        state.send(.needsChanged(cards))
        XCTAssertEqual(state.presentation.need?.id, "door", "Even a mind-less creature can ask for approval")
        var (signing, id) = signingIn()
        signing.send(.needsChanged(cards))
        signing.send(.loginPolled(id, .success(LoginProgress(status: "ok"))))
        signing.send(.loginConfirmed(id, .success(fed)))
        XCTAssertEqual(signing.presentation.need?.id, "door", "No timer tick is necessary")
    }

    func testRepeatSignInRestoresCodeAndCanCancel() {
        var (state, id) = signingIn()
        state.send(.submit(.ask, "Hello"))
        XCTAssertTrue(state.presentation.line.contains(code.code), "Hunger must not erase the active code")
        XCTAssertEqual(state.send(.signIn), [.showCode(code)])
        let card = state.presentation.need!
        let effects = state.send(.answer(card, card.opts.last!))
        XCTAssertTrue(effects.contains(.cancel(.login)))
        XCTAssertTrue(effects.contains(.restoreClipboard))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertEqual(state.send(.wake(.poll(id))), [], "No more polls after cancel")
        XCTAssertEqual(state.send(.loginConfirmed(id, .success(fed))), [], "Late completions cannot feed a cancelled flow")
    }

    func testShutdownCancelsSignInAndRestoresClipboard() {
        var (state, _) = signingIn()
        let effects = state.send(.shutdown)
        XCTAssertTrue(effects.contains(.cancel(.login)))
        XCTAssertTrue(effects.contains(.restoreClipboard))
        XCTAssertEqual(state.send(.signIn), [])
    }

    func testReleaseDuringPermissionNeverStartsEars() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.keyUp(.ask))
        XCTAssertEqual(state.send(.authorized(id, .allowed)), [])
        XCTAssertEqual(state.presentation.posture, .idle)
        let next = startListening(&state)
        XCTAssertNotEqual(id, next)
        XCTAssertEqual(state.presentation.posture, .listening)
    }

    func testReleaseDuringAudioStartStopsItImmediately() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.authorized(id, .allowed))
        state.send(.keyUp(.ask))
        XCTAssertEqual(state.send(.earsStarted(id, true)), [.stopEars(id)])
        state.send(.heard(id, ""))
        XCTAssertEqual(state.presentation.posture, .idle)
    }

    func testOldRestCannotCollapseNewListenOrCard() {
        var state = ready()
        let ask = effectID(state.send(.submit(.ask, "Hello")))
        state.send(.replied(ask, .success(reply())))
        XCTAssertEqual(state.send(.spoken(ask)), [.wait(2, .rest(ask))])
        let listen = startListening(&state)
        state.send(.partial(listen, "The new words"))
        state.send(.wake(.rest(ask)))
        XCTAssertEqual(state.presentation.posture, .listening)
        XCTAssertEqual(state.presentation.line, "The new words")
        let card = Need(id: "choice", title: "Can I write a note?", opts: [NeedOption(label: "Yes")])
        state.send(.needsChanged([card]))
        state.send(.keyUp(.ask)); state.send(.heard(listen, ""))
        XCTAssertEqual(state.presentation.need?.id, card.id)
        state.send(.wake(.rest(ask)))
        XCTAssertEqual(state.presentation.need?.id, card.id)
    }

    func testOnlyOneQuestionCanBeInFlight() {
        var state = ready()
        let first = effectID(state.send(.submit(.ask, "First question")))
        XCTAssertEqual(state.send(.keyDown(.ask)), [])
        XCTAssertEqual(state.send(.submit(.ask, "Second question")), [])
        state.send(.keyUp(.ask))
        XCTAssertEqual(state.presentation.posture, .thinking)
        state.send(.replied(first, .success(reply("First answer"))))
        XCTAssertEqual(state.history.map { $0["content"]! }, ["First question", "First answer"])
        _ = startListening(&state)
        XCTAssertEqual(state.send(.replied(first, .success(reply("Late duplicate")))), [])
        XCTAssertEqual(state.history.count, 2)
    }

    func testBlockedStatesHaveDismissAndSettingActions() {
        for permission in [HearingPermission.microphone, .speech] {
            var state = ready()
            let id = effectID(state.send(.keyDown(.ask)))
            state.send(.authorized(id, permission))
            let need = state.presentation.need!
            XCTAssertEqual(state.presentation.posture, .needsYou)
            XCTAssertTrue(need.opts.first!.action!.hasPrefix("open:"))
            state.send(.answer(need, need.opts.last!))
            XCTAssertEqual(state.presentation.posture, .idle)
            XCTAssertFalse(state.presentation.expanded)
        }
        for mode in [TalkMode.dictate, .screen] {
            var state = ready()
            let id = effectID(state.send(.submit(mode, "Do this")))
            state.send(mode == .dictate ? .dictated(id, false) : .screenRead(id, .failure(.unavailable)))
            let need = state.presentation.need!
            XCTAssertTrue(need.opts.first!.action!.hasPrefix("open:"))
            state.send(.later(need))
            XCTAssertEqual(state.presentation.posture, .idle)
        }
    }

    func testFailedLookupRetriesWithClockAndStillHasWorkingButton() {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        XCTAssertEqual(state.send(.found(id, .failure(.unavailable))), [.wait(30, .retry(id))])
        XCTAssertEqual(state.presentation.need?.opts.first?.label, "Find my mind")
        let retry = effectID(state.send(.wake(.retry(id))))
        XCTAssertGreaterThan(retry, id)
        state.send(.found(retry, .success(fed)))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertEqual(state.send(.wake(.retry(id))), [])
    }

    func testDismissingMissingMindKeepsAutomaticRetriesQuiet() {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        state.send(.found(id, .failure(.unavailable)))
        let card = state.presentation.need!
        state.send(.answer(card, card.opts.last!))
        XCTAssertEqual(state.presentation.posture, .idle)
        let retry = effectID(state.send(.wake(.retry(id))))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertFalse(state.presentation.expanded)
        state.send(.found(retry, .failure(.unavailable)))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertFalse(state.presentation.expanded)
    }

    func testUnreachableMindOffersWorkingRetry() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "Question")))
        state.send(.replied(id, .failure(.unavailable)))
        let card = state.presentation.need!
        XCTAssertTrue(card.title.contains("Choose Find my mind"))
        let retry = effectID(state.send(.answer(card, card.opts[0])))
        state.send(.found(retry, .success(fed)))
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertNil(state.presentation.need)
    }

    func testFailedSignInReattachesBeforeRetry() {
        var state = ready(hungry)
        let id = effectID(state.send(.signIn))
        state.send(.loginStarted(id, .failure(.unavailable)))
        XCTAssertFalse(state.presentation.line.contains("Is it running"))
        XCTAssertTrue(state.presentation.line.contains("Choose Sign me in"))
        let find = effectID(state.send(.signIn))
        XCTAssertEqual(state.presentation.line, "Finding my mind.")
        let login = effectID(state.send(.found(find, .success(hungry))))
        XCTAssertNotEqual(login, id)
        state.send(.loginStarted(login, .success(code)))
        XCTAssertTrue(state.presentation.line.contains(code.code))
    }

    func testLoginSetupFailureShowsPlainRecovery() {
        var state = ready()
        let id = effectID(state.send(.installAtLogin))
        state.send(.installedAtLogin(id, .failure(.unavailable)))
        let need = state.presentation.need!
        XCTAssertEqual(state.presentation.posture, .needsYou)
        XCTAssertTrue(need.title.contains("Choose Try again"))
        XCTAssertEqual(need.opts.first?.action, "creature:install-login")
        XCTAssertFalse(need.title.contains("Couldn't set that up:"))
        let retry = effectID(state.send(.answer(need, need.opts[0])))
        XCTAssertNotEqual(retry, id)
    }

    func testMissingAppleToolsHasInstallActionWithoutRetryLoop() {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        XCTAssertEqual(state.send(.found(id, .failure(.toolsMissing))), [])
        let need = state.presentation.need!
        XCTAssertEqual(need.opts.first?.label, "Install")
        XCTAssertEqual(state.send(.answer(need, need.opts[0])), [.installTools])
        XCTAssertEqual(state.send(.wake(.retry(id))), [])
    }

    func testEveryPermissionHasCorrectSettingAndDismissal() {
        for (permission, pane) in [
            (CreatureStateMachine.Permission.microphone, "Microphone"), (.speech, "SpeechRecognition"),
            (.typing, "Accessibility"), (.screen, "ScreenCapture"), (.texts, "AllFiles"),
        ] {
            let card = CreatureStateMachine.permissionCard(permission)
            XCTAssertEqual(card.opts[0].label, "Open the setting")
            XCTAssertEqual(card.opts[0].action,
                           "open:x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)")
            XCTAssertEqual(card.opts.last?.label, "Not now")
            XCTAssertTrue(card.title.contains("Choose Open the setting"))
            var state = ready()
            state.send(.needsChanged([card]))
            let effects = state.send(.answer(card, card.opts[0]))
            XCTAssertTrue(effects.contains(.open(URL(string: String(card.opts[0].action!.dropFirst(5)))!)))
            XCTAssertEqual(state.presentation.posture, .idle)
        }
    }

    func testDictationAndScreenUseTheirOwnInjectedEffects() {
        var state = ready()
        let dictate = effectID(state.send(.submit(.dictate, "Write these words")))
        XCTAssertEqual(state.send(.dictated(dictate, true)), [.wait(1, .rest(dictate))])
        state.send(.wake(.rest(dictate)))
        XCTAssertEqual(state.presentation.posture, .idle)
        let screen = effectID(state.send(.submit(.screen, "Explain this")))
        let effects = state.send(.screenRead(screen, .success("A picture of a cat")))
        guard case .chat(let id, let message, _, _) = effects.first else { return XCTFail("Expected a screen question") }
        XCTAssertEqual(id, screen)
        XCTAssertTrue(message.contains("A picture of a cat"))
        XCTAssertTrue(message.contains("Explain this"))
    }

    func testHistoryStaysOrderedAndBoundedAcrossElevenQuestions() {
        var state = ready()
        for n in 0..<11 {
            let id = effectID(state.send(.submit(.ask, "Question \(n)")))
            state.send(.replied(id, .success(reply("Answer \(n)"))))
            state.send(.spoken(id)); state.send(.wake(.rest(id)))
        }
        XCTAssertEqual(state.history.count, 20)
        XCTAssertEqual(state.history.first?["content"], "Question 1")
        XCTAssertEqual(state.history.last?["content"], "Answer 10")
        XCTAssertEqual(state.sessionId, "conversation")
    }

    func testNeedsYouAlwaysHasActionAndNoMachineWords() {
        var cases: [CreatureStateMachine] = []
        var missing = CreatureStateMachine()
        let find = effectID(missing.send(.findMind))
        missing.send(.found(find, .failure(.unavailable))); cases.append(missing)
        cases.append(ready(hungry)); cases.append(signingIn().0)
        var help = ready(); help.send(.showHelp); cases.append(help)
        for connected in [true, false] {
            var state = ready()
            state.send(.connectedHelper(connected))
            cases.append(state)
        }
        for state in cases {
            XCTAssertEqual(state.presentation.posture, .needsYou)
            XCTAssertFalse(state.presentation.need?.opts.isEmpty ?? true)
            assertPlain(state.presentation.line)
        }
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "What is a kernel HTTP port?")))
        XCTAssertEqual(state.presentation.line, "What is a kernel HTTP port?")
        let effects = state.send(.replied(id, .success(MindReply(
            text: "The kernel process uses a socket, token and JSON.",
            senses: ["voice": "HTTP port 405"], sessionId: nil, raw: ""))))
        XCTAssertEqual(state.presentation.line, "The kernel process uses a socket, token and JSON.")
        guard case .speak(_, let spoken) = effects.first else { return XCTFail("Expected speech") }
        XCTAssertEqual(spoken, "HTTP port 405")
    }

    func assertPlain(_ words: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(words.range(of: #"\b(kernel|launchd|plist|json|http|https|port|socket|token|process|pid|405)\b"#,
                                 options: [.regularExpression, .caseInsensitive]), words, file: file, line: line)
    }
}
