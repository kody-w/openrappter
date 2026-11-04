import AppKit
import Speech
import XCTest
@testable import OpenRappterCore

extension CreatureStateMachineTests {
    func testFailedKeepNeverDemotesAnAnsweringMindEvenAfterNoticeExpires() {
        for failure in [CreatureFailure.toolsMissing, .unavailable] {
            var state = ready()
            let timeout = noticeWake(state.send(.showHelp))
            let setup = effectID(state.send(.installAtLogin))
            state.send(.installedAtLogin(setup, .failure(failure)))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertEqual(state.presentation.need?.opts.first?.action,
                           failure == .toolsMissing ? "creature:install-tools" : "creature:install-login")
            state.send(.wake(timeout))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertEqual(state.presentation.need?.opts.first?.action,
                           failure == .toolsMissing ? "creature:install-tools" : "creature:install-login")
            let ask = state.send(.submit(.ask, "Does my working mind still answer?"))
            guard case .chat(let id, _, _, _) = ask.last else {
                return XCTFail("Startup setup must not change the live mind's readiness")
            }
            state.send(.replied(id, .success(reply())))
            XCTAssertEqual(state.history.count, 2)
        }
    }

    func testStopStartupRearmsAMissingMindsAutomaticRetry() {
        var state = CreatureStateMachine()
        let lookup = effectID(state.send(.findMind))
        state.send(.found(lookup, .failure(.unavailable)))
        XCTAssertTrue(state.send(.stopAtLogin).contains(.cancel(.retry)))
        let stopped = state.send(.stoppedAtLogin(true))
        XCTAssertTrue(stopped.contains(.wait(30, .retry(lookup))))
        state.send(.wake(noticeWake(stopped)))
        let retried = state.send(.wake(.retry(lookup)))
        XCTAssertTrue(retried.contains { if case .findMind = $0 { return true }; return false })
        state.send(.found(effectID(retried), .success(fed)))
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertTrue(state.send(.submit(.ask, "Hello")).contains {
            if case .chat = $0 { return true }; return false
        })
    }

    func testStoppingStartupCancelsThePendingKeepRequest() {
        var state = ready()
        let setup = effectID(state.send(.installAtLogin))
        state.send(.installedAtLogin(setup, .failure(.toolsMissing)))
        let oldTools = state.presentation.need!
        state.send(.stopAtLogin)
        state.send(.stoppedAtLogin(true))
        let find = oldTools.opts.first { $0.action == "creature:find" }!
        let work = state.send(.answer(oldTools, find))
        XCTAssertTrue(work.contains { if case .findMind = $0 { return true }; return false })
        XCTAssertFalse(work.contains { if case .installAtLogin = $0 { return true }; return false },
                       "A superseded Keep request must never undo a newer Stop choice")
    }

    func testBusyDictationDescribesTypingAndPreservesTheActualWords() {
        var state = ready()
        let id = effectID(state.send(.submit(.dictate, "The exact words to type")))
        XCTAssertEqual(state.send(.keyDown(.ask)), [])
        XCTAssertEqual(state.presentation.line, "Still typing your words.")
        XCTAssertEqual(state.presentation.posture, .thinking)
        XCTAssertTrue(state.history.isEmpty)
        state.send(.dictated(id, true))
        state.send(.wake(.rest(id)))
        XCTAssertEqual(state.presentation.line, "Typed it. The exact words to type")
    }

    func testBusyScreenReadingDescribesTheActualStageWithoutStartingAnotherAsk() {
        var state = ready()
        let id = effectID(state.send(.submit(.screen, "Explain this window")))
        XCTAssertEqual(state.send(.keyDown(.dictate)), [])
        XCTAssertEqual(state.presentation.line, "Still reading your screen.")
        let chat = state.send(.screenRead(id, .success("The window's text")))
        XCTAssertEqual(effectID(chat), id)
        XCTAssertEqual(state.send(.keyDown(.ask)), [])
        XCTAssertEqual(state.presentation.line, "Still thinking about your last question.")
        state.send(.replied(id, .success(reply())))
        XCTAssertEqual(state.history.first?["content"], "Explain this window")
    }

    func testAnswerNoticeExpiresWithoutAClickAndKeepsHistory() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "A question")))
        state.send(.replied(id, .success(reply("The complete answer."))))
        state.send(.spoken(id))
        let settled = state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "The complete answer.")
        let timeout = noticeWake(settled)
        state.send(.wake(timeout))
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertEqual(state.presentation.posture, .idle)
        XCTAssertFalse(state.presentation.canDismissLine)
        XCTAssertEqual(state.presentation.line, "Hold Option and Space and talk to me.")
        XCTAssertEqual(state.history.map { $0["content"]! }, ["A question", "The complete answer."])
    }

    func testEveryBriefTapOutcomeAutomaticallyCompacts() {
        for outcome in ["granted", "empty", "recognition-error", "microphone", "speech", "unavailable"] {
            var state = ready()
            let id = effectID(state.send(.keyDown(.ask)))
            let effects: [CreatureEffect]
            switch outcome {
            case "granted":
                state.send(.keyUp(.ask))
                effects = state.send(.authorized(id, .allowed))
            case "microphone", "speech":
                state.send(.keyUp(.ask))
                effects = state.send(.authorized(id, outcome == "microphone" ? .microphone : .speech))
            case "unavailable":
                state.send(.authorized(id, .allowed))
                effects = state.send(.hearingFailed(id, .recognizerUnavailable))
            default:
                state.send(.authorized(id, .allowed))
                state.send(.earsStarted(id, true))
                state.send(.keyUp(.ask))
                effects = state.send(outcome == "empty" ? .heard(id, "") : .hearingFailed(id, .recognitionFailed))
            }
            XCTAssertTrue(state.presentation.expanded, outcome)
            state.send(.wake(noticeWake(effects)))
            XCTAssertFalse(state.presentation.expanded, "\(outcome) must not require a click")
            XCTAssertEqual(state.presentation.posture, .idle)
        }
    }

    func testDictationAndSetupNoticesAlsoExpireWithoutAClick() {
        var state = ready()
        let dictate = effectID(state.send(.submit(.dictate, "A note")))
        state.send(.dictated(dictate, true))
        let typed = state.send(.wake(.rest(dictate)))
        state.send(.wake(noticeWake(typed)))
        XCTAssertFalse(state.presentation.expanded)
        let setup = effectID(state.send(.installAtLogin))
        let confirmed = state.send(.installedAtLogin(setup, .success(.installed)))
        XCTAssertTrue(state.presentation.line.contains("I'll come back"))
        state.send(.wake(noticeWake(confirmed)))
        XCTAssertFalse(state.presentation.expanded)
    }

    func testOldNoticeTimeoutCannotCollapseANewListenOrANewerNotice() {
        var state = ready()
        let old = noticeWake(state.send(.showInput))
        let id = startListening(&state)
        state.send(.wake(old))
        XCTAssertEqual(state.presentation.posture, .listening)
        XCTAssertTrue(state.presentation.expanded)
        state.send(.keyUp(.ask))
        let new = noticeWake(state.send(.heard(id, "")))
        state.send(.wake(old))
        XCTAssertTrue(state.presentation.line.contains("didn't catch"))
        XCTAssertTrue(state.presentation.expanded)
        state.send(.wake(new))
        XCTAssertFalse(state.presentation.expanded)
    }

    func testRequestingTheSameHelpAgainGetsANewReadingInterval() {
        var state = ready()
        let old = noticeWake(state.send(.showHelp))
        let new = noticeWake(state.send(.showHelp))
        XCTAssertNotEqual(old, new)
        state.send(.wake(old))
        XCTAssertTrue(state.presentation.expanded)
        state.send(.wake(new))
        XCTAssertFalse(state.presentation.expanded)
    }

    func testUnsentDraftSuspendsAutomaticCompactingUntilItIsCleared() {
        var state = ready()
        let old = noticeWake(state.send(.showInput))
        XCTAssertEqual(state.send(.draftChanged(true)), [.cancel(.notice)])
        state.send(.wake(old))
        XCTAssertTrue(state.presentation.expanded)
        let resumed = noticeWake(state.send(.draftChanged(false)))
        state.send(.wake(resumed))
        XCTAssertFalse(state.presentation.expanded)
    }

    func testAutomaticNoticeDismissalNeverAnswersOrHidesACallersDecision() {
        var state = ready()
        let old = noticeWake(state.send(.showHelp))
        let caller = Need(id: "door-choice", title: "May I send your note?",
                          opts: [NeedOption(label: "Yes"), NeedOption(label: "No")], source: "doors")
        let shown = state.send(.needsChanged([caller]))
        XCTAssertTrue(shown.contains(.cancel(.notice)))
        XCTAssertFalse(shown.contains { if case .wait = $0 { return true }; return false })
        XCTAssertEqual(state.send(.wake(old)), [])
        XCTAssertEqual(state.presentation.need, caller)
        XCTAssertTrue(state.presentation.expanded)
    }

    func testOptionalCardsCannotKeepAnExpiredAnswerExpanded() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "Question")))
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.replied(id, .success(reply())))
        state.send(.spoken(id))
        let timeout = noticeWake(state.send(.wake(.rest(id))))
        state.send(.wake(timeout))
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertNil(state.presentation.need)
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        XCTAssertFalse(state.presentation.expanded, "A folder reload must not reopen an optional card")
        state.send(.showPermission(.texts))
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.texts))
    }

    func testSuccessfulSignInConfirmsReadablyThenCompactsWithoutAClick() {
        var (state, id) = signingIn()
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.loginPolled(id, .success(LoginProgress(status: "success"))))
        let done = state.send(.loginConfirmed(id, .success(fed)))
        XCTAssertEqual(state.presentation.line, "You're signed in. I'm ready to help.")
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertFalse(state.presentation.hungry)
        state.send(.wake(noticeWake(done)))
        XCTAssertFalse(state.presentation.expanded, "Automatic setup advice must not keep the notch open")
        XCTAssertNil(state.presentation.need)
    }

    func testTypedAndSpokenQuestionsDuringLookupExplainThatTheyWereNotSent() {
        for spoken in [false, true] {
            var state = CreatureStateMachine()
            let lookup = effectID(state.send(.findMind))
            let effects: [CreatureEffect]
            if spoken {
                let id = startListening(&state)
                state.send(.keyUp(.ask))
                effects = state.send(.heard(id, "What time is it?"))
            } else {
                effects = state.send(.submit(.ask, "What time is it?"))
            }
            XCTAssertTrue(state.presentation.line.contains("question hasn't been sent"))
            XCTAssertTrue(state.presentation.line.contains("ask again"))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertFalse(effects.contains { if case .chat = $0 { return true }; return false })
            XCTAssertTrue(effects.contains { if case .speak = $0 { return true }; return false },
                          "A voice-first owner must hear the acknowledgement too")
            XCTAssertTrue(state.history.isEmpty)
            state.send(.found(lookup, .success(fed)))
            XCTAssertEqual(state.presentation.line, "I'm ready now. Please ask your question again.")
            let retried = state.send(.submit(.ask, "What time is it?"))
            XCTAssertTrue(retried.contains { if case .chat = $0 { return true }; return false })
        }
    }

    func testQuestionsBeforeSignInOrWithAMissingMindHaveAnExplanationAndRecovery() {
        for health in [Optional<MindHealth>.none, hungry,
                       MindHealth(status: "ok", version: "", model: "", agentCount: 0, copilot: "no_access")] {
            for spoken in [false, true] {
                var state = health.map { ready($0) } ?? CreatureStateMachine()
                if spoken {
                    let id = startListening(&state)
                    state.send(.keyUp(.ask))
                    state.send(.heard(id, "Hello"))
                } else { state.send(.submit(.ask, "Hello")) }
                XCTAssertTrue(state.presentation.line.contains("question hasn't been sent"))
                XCTAssertTrue(state.presentation.line.contains("ask again"))
                XCTAssertEqual(state.presentation.need?.opts.first?.action,
                               health == nil ? "creature:find" : "creature:sign-in")
            }
        }
        var (state, id) = signingIn()
        state.send(.submit(.ask, "Hello"))
        XCTAssertTrue(state.presentation.line.contains(code.code))
        XCTAssertTrue(state.presentation.line.contains("question hasn't been sent"))
        XCTAssertEqual(state.send(.wake(.poll(id))), [.pollLogin(id)])
    }

    @MainActor
    func testLaterHidesCodeButKeepsPollingAndClipboardUntilExplicitCancellation() {
        let board = ClipboardLeaseTests.Board()
        let original = [["public.utf8-plain-text": Data("owner's clipboard".utf8)]]
        board.write(original)
        let lease = board.lease()
        var (state, login) = signingIn()
        lease.copy(code.code)
        let effects = state.send(.later(state.presentation.need!))
        for case .restoreClipboard in effects { lease.restore() }
        XCTAssertEqual(effects, [])
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertEqual(board.items.first?["public.utf8-plain-text"], Data(code.code.utf8))
        XCTAssertEqual(state.send(.wake(.poll(login))), [.pollLogin(login)])
        XCTAssertEqual(state.send(.signIn), [.showCode(code)])
        let card = state.presentation.need!
        let cancel = card.opts.first { $0.action == "creature:cancel-login" }!
        let cancelled = state.send(.answer(card, cancel))
        for case .restoreClipboard in cancelled { lease.restore() }
        XCTAssertEqual(board.items, original)
        XCTAssertEqual(state.send(.wake(.poll(login))), [])
    }

    func testScreenPermissionExplainsTheRequiredRelaunchAndRetry() {
        var state = ready()
        let id = effectID(state.send(.submit(.screen, "Read this")))
        state.send(.screenRead(id, .failure(.unavailable)))
        let card = state.presentation.need!
        XCTAssertTrue(card.title.contains("allow OpenRappter"))
        XCTAssertTrue(card.title.contains("Restart OpenRappter"))
        XCTAssertTrue(card.title.contains("ask about your screen again"))
        XCTAssertTrue(card.opts.contains { $0.action?.contains("Privacy_ScreenCapture") == true })
    }
}

extension StartupAdapterRegressionTests {
    func testDictationActuallyRequestsAccessibilityBeforeShowingItsSetting() async throws {
        let (effects, _, _) = try fixture()
        var prompts: [Bool] = []
        effects.dictationTrusted = { prompts.append($0); return false }
        effects.pasteText = { _ in XCTFail("Do not paste without permission"); return "denied" }
        var state = CreatureStateMachine()
        let work = state.send(.submit(.dictate, "Type this"))
        let event = await effects.perform(work.last!)
        XCTAssertEqual(prompts, [true], "Checking with prompt:false leaves the app absent from the setting")
        if let event { state.send(event) }
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.typing))
        XCTAssertTrue(state.presentation.need!.opts[0].action!.contains("Privacy_Accessibility"))
    }

    func testAllowedDictationDoesNotLoseItsWordsOrRequestUnrelatedPermissions() async throws {
        let (effects, _, _) = try fixture()
        var prompts: [Bool] = []
        effects.dictationTrusted = { prompts.append($0); return true }
        var pasted: [String] = []
        effects.pasteText = { pasted.append($0); return "ax" }
        let event = await effects.perform(.dictate(7, "The owner's exact words"))
        XCTAssertEqual(event, .dictated(7, true))
        XCTAssertEqual(prompts, [true])
        XCTAssertEqual(pasted, ["The owner's exact words"])
    }

    func testFindActionAfterInstallingToolsFinishesTheOriginalKeepRequest() async throws {
        let (effects, commands, home) = try fixture()
        commands.loaded.insert(LoginItem.label)
        _ = await effects.perform(.stopAtLogin)
        XCTAssertTrue(StartupPreference(home: home).isStopped)
        effects.runner.toolsReady = { false }
        var state = CreatureStateMachine()
        let shown = state.send(.showHelp)
        let timeout = try XCTUnwrap(shown.compactMap { effect -> CreatureWake? in
            if case .wait(8, let wake) = effect { return wake }; return nil
        }.first)
        let keep = state.send(.installAtLogin).first!
        if let failed = await effects.perform(keep) { state.send(failed) }
        state.send(.wake(timeout))
        XCTAssertTrue(state.presentation.expanded)
        let tools = try XCTUnwrap(state.presentation.need)
        XCTAssertTrue(tools.title.contains("then choose Find my mind"))
        XCTAssertEqual(state.send(.answer(tools, tools.opts[0])), [.installTools])
        state.send(.wake(timeout))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need, tools)
        effects.runner.toolsReady = { true }
        let find = try XCTUnwrap(tools.opts.first { $0.action == "creature:find" })
        let recovery = state.send(.answer(tools, find))
        let setup = try XCTUnwrap(recovery.first { if case .installAtLogin = $0 { return true }; return false })
        if let result = await effects.perform(setup) { state.send(result) }
        XCTAssertFalse(StartupPreference(home: home).isStopped)
        XCTAssertTrue(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
        XCTAssertTrue(effects.runner.serviceInstalled)
        XCTAssertTrue(commands.loaded.contains(LoginItem.label))
        XCTAssertTrue(commands.loaded.contains(MindRunner.serviceLabel))
        XCTAssertTrue(state.presentation.line.contains("I'll come back"))
    }
}

extension MindStartupTests {
    func testFailedLauncherRefreshCannotBreakAHealthyAttachment() async throws {
        let dir = try testDirectory(self)
        var runner = try runner(dir)
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        runner.candidates = [URL(string: "http://127.0.0.1:\(kernel.port)")!]
        try Data("saved".utf8).write(to: runner.launchAgentURL)
        try FileManager.default.createDirectory(at: runner.kernelHome, withIntermediateDirectories: true)
        try Data("not a folder".utf8).write(to: runner.kernelHome.appendingPathComponent("launcher"))
        runner.command = { _ in XCTFail("Do not restart a working mind"); return 0 }
        runner.toolsReady = { XCTFail("A working mind does not need tools"); return false }
        final class Messages: @unchecked Sendable { var lines: [String] = [] }
        let messages = Messages()
        runner.log = { messages.lines.append($0) }
        let attached = try await runner.findMind(attempts: 0)
        XCTAssertEqual(attached.0.baseURL.port, Int(kernel.port))
        XCTAssertEqual(attached.1.status, "ok")
        XCTAssertTrue(messages.lines.contains { $0.contains("launcher refresh failed") })
    }

    func testFirstSetupCanTakeMoreThanFourMinutesWithoutClaimingTheMindIsMissing() async throws {
        let dir = try testDirectory(self)
        var runner = try runner(dir)
        runner.candidates = []
        runner.command = { _ in 0 }
        runner.toolsReady = { true }
        var healthReads = 0
        MindFixtureProtocol.reply = { _ in
            healthReads += 1
            return (200, healthReads <= 130 ? #"{"status":"starting"}"# : #"{"status":"ok","agents":[]}"#)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MindFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        runner.makeClient = { url, _ in
            var client = MindClient(baseURL: url)
            client.session = session
            return client
        }
        var elapsed = 0.0
        var progress = 0
        let result = try await runner.findMind(sleep: { elapsed += $0 }, onWaiting: { progress += 1 })
        XCTAssertGreaterThan(elapsed, 240)
        XCTAssertGreaterThan(progress, 0)
        XCTAssertEqual(result.1.status, "ok")
        XCTAssertEqual(healthReads, 131)
    }
}

extension MindProtocolRegressionTests {
    func testKernelErrorStatusWithExpiredTokenGetsFreshCodeGuidance() async throws {
        for error in ["Login failed: expired_token", "The device code has expired"] {
            let mind = client { _ in (200, #"{"status":"error","error":"\#(error)"}"#) }
            let progress = try await mind.loginProgress()
            XCTAssertEqual(progress.status, "error", "Exercise the kernel's real expiry shape, not status:expired")
            var state = CreatureStateMachine()
            let lookup = state.send(.findMind)
            guard case .findMind(let found) = lookup.last else { return XCTFail("Lookup") }
            state.send(.found(found, .success(MindHealth(status: "unauthenticated", version: "", model: "", agentCount: 0))))
            let login = state.send(.signIn)
            guard let start = login.first(where: { if case .startLogin = $0 { return true }; return false }),
                  case .startLogin(let id) = start else { return XCTFail("Login") }
            state.send(.loginPolled(id, .success(progress)))
            XCTAssertTrue(state.presentation.line.contains("That code expired"), state.presentation.line)
            XCTAssertTrue(state.presentation.line.contains("fresh one"))
            XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:sign-in")
        }
    }
}

extension NeedsTests {
    func testAutomaticPermissionDeferralPersistsWithoutAnsweringIt() throws {
        let dir = try testDirectory(self)
        let queue = NeedsQueue(dir: dir)
        let permission = CreatureStateMachine.permissionCard(.texts)
        queue.add(permission)
        var state = CreatureStateMachine()
        let lookup = state.send(.findMind)
        guard case .findMind(let id) = lookup.last else { return XCTFail("Lookup") }
        state.send(.found(id, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
        let shown = state.send(.needsChanged(queue.needs))
        guard let timeout = shown.compactMap({ effect -> CreatureWake? in
            if case .wait(8, let wake) = effect { return wake }; return nil
        }).first else { return XCTFail("Automatic dismissal") }
        let dismissed = state.send(.wake(timeout))
        for case .later(let need) in dismissed { queue.later(need) }
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertNil(NeedsQueue(dir: dir).top)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(permission.id).answer.json").path))
    }

    func testDeferredTextsPermissionDoesNotReturnOnTheNextLaunch() throws {
        let dir = try testDirectory(self)
        let first = NeedsQueue(dir: dir)
        var permission = CreatureStateMachine.permissionCard(.texts)
        permission.id = "permission-texts"
        first.add(permission)
        first.later(permission)
        XCTAssertNil(first.top)
        let reopened = NeedsQueue(dir: dir)
        XCTAssertNil(reopened.top, "Later must survive reopening rather than nag on every launch")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("permission-texts.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("permission-texts.answer.json").path))
    }
}

final class CreatureHandoffTests: XCTestCase {
    let home = URL(fileURLWithPath: "/Users/owner")
    let installed = URL(fileURLWithPath: "/Applications/OpenRappter.app")

    func testApplicationsCopyRetiresDMGOrTranslocatedCopyInsteadOfWaitingForever() {
        for path in ["/Volumes/OpenRappter/OpenRappter.app", "/private/tmp/AppTranslocation/ABC/OpenRappter.app"] {
            var running = [CreatureInstance(id: 20, bundle: URL(fileURLWithPath: path))]
            var retired: [Int32] = []
            let claimed = CreatureHandoff.claim(bundle: installed, home: home, id: 21, running: { running },
                                                retire: { id, force in
                XCTAssertFalse(force)
                retired.append(id)
                running.removeAll { $0.id == id }
            }, pause: { XCTFail("A retired disposable copy must not block opening Applications") })
            XCTAssertTrue(claimed)
            XCTAssertEqual(retired, [20])
        }
    }

    func testUnresponsiveDisposableCopyHasABoundedHandoff() {
        var running = [CreatureInstance(id: 20, bundle: URL(fileURLWithPath: "/Volumes/OpenRappter/OpenRappter.app"))]
        var pauses = 0
        var forced: [Bool] = []
        let claimed = CreatureHandoff.claim(bundle: installed, home: home, id: 21, running: { running },
                                            retire: { _, force in
            forced.append(force)
            if force { running = [] }
        }, pause: { pauses += 1 })
        XCTAssertTrue(claimed)
        XCTAssertEqual(forced, [false, true])
        XCTAssertEqual(pauses, 20)
    }

    func testHandoffNeverTerminatesAnInstalledOrUnidentifiedPeer() {
        for bundle in [Optional(installed), nil] {
            let claimed = CreatureHandoff.claim(bundle: installed, home: home, id: 21,
                                                running: { [CreatureInstance(id: 20, bundle: bundle)] },
                                                retire: { _, _ in XCTFail("Only known disposable copies may be retired") },
                                                pause: { XCTFail("Do not wait forever for an installed peer") })
            XCTAssertFalse(claimed)
        }
    }
}

@MainActor
final class SpeechRecognitionRegressionTests: XCTestCase {
    func testRecognitionFailureIsNotSilenceAndNextCaptureCanStillSucceed() async throws {
        var removed = 0
        let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in }, start: {},
                                        stop: {}, remove: { removed += 1 })
        var receive: ((String?, Bool, Error?) -> Void)?
        let ears = Ears(capture: capture, available: { true }, recognize: { _, callback in
            receive = callback
            return {}
        })
        try ears.start()
        receive?(nil, false, NSError(domain: "Speech", code: 1))
        let failure = await ears.stop()
        XCTAssertEqual(failure, .failure(.recognitionFailed))
        XCTAssertEqual(removed, 1)
        XCTAssertFalse(ears.listening)
        try ears.start()
        receive?("The next complete sentence", true, nil)
        let success = await ears.stop()
        XCTAssertEqual(success, .success("The next complete sentence"))
        XCTAssertEqual(removed, 2)
    }

    func testUnavailableRecognizerNeverTouchesTheMicrophoneOrClaimsItIsMissing() async throws {
        let capture = MicrophoneCapture(format: { XCTFail("Do not inspect the microphone"); return (0, 0) },
                                        install: { _ in XCTFail("Do not install audio") }, start: {}, stop: {}, remove: {})
        let ears = Ears(capture: capture, available: { false }, recognize: { _, _ in
            XCTFail("Unavailable recognizer must not start")
            return {}
        })
        XCTAssertThrowsError(try ears.start()) {
            XCTAssertEqual($0 as? EarsError, .recognizerUnavailable)
        }
        let dir = try testDirectory(self)
        let effects = MacCreatureEffects(runner: MindRunner(kernelDir: dir), needs: NeedsQueue(dir: dir), ears: ears,
                                         voice: Voice(output: { _ in }, stop: {}))
        var state = CreatureStateMachine()
        let work = state.send(.keyDown(.ask))
        guard case .authorize(let id) = work.last else { return XCTFail("Authorize") }
        state.send(.authorized(id, .allowed))
        let event = await effects.perform(.startEars(id))
        XCTAssertEqual(event, .hearingFailed(id, .recognizerUnavailable))
        if let event { state.send(event) }
        XCTAssertTrue(state.presentation.line.contains("Speech recognition isn't available"))
        XCTAssertFalse(state.presentation.line.contains("can't hear a microphone"))
        XCTAssertNil(state.presentation.need)
    }

    func testMacAdapterReportsRecognitionFailureInsteadOfAnEmptyTranscript() async throws {
        let capture = MicrophoneCapture(format: { (48000, 1) }, install: { _ in }, start: {}, stop: {}, remove: {})
        var receive: ((String?, Bool, Error?) -> Void)?
        let ears = Ears(capture: capture, available: { true }, recognize: { _, callback in
            receive = callback; return {}
        })
        let dir = try testDirectory(self)
        let effects = MacCreatureEffects(runner: MindRunner(kernelDir: dir), needs: NeedsQueue(dir: dir), ears: ears,
                                         voice: Voice(output: { _ in }, stop: {}))
        _ = await effects.perform(.startEars(3))
        receive?(nil, false, NSError(domain: "Speech", code: 1))
        let event = await effects.perform(.stopEars(3))
        XCTAssertEqual(event, .hearingFailed(3, .recognitionFailed))
    }
}
