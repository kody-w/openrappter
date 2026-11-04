import AppKit
import XCTest
@testable import OpenRappterCore

extension CreatureStateMachineTests {
    func testMenuHasAPlainEnabledQuitAction() {
        let quit = CreatureMenu.entries.first { $0.command == .goToSleep }
        XCTAssertEqual(quit?.title, "Go to sleep (Quit OpenRappter)")
        XCTAssertTrue(quit?.children.isEmpty == true)
    }

    func testTypedSleepQuitsWithoutAskingTheMind() {
        var state = ready()
        let effects = state.send(.submit(.ask, "  Go to sleep. \n"))
        XCTAssertTrue(effects.contains(.quit))
        XCTAssertFalse(effects.contains { if case .chat = $0 { return true }; return false })
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Going to sleep.")
        XCTAssertNil(state.presentation.need)
    }

    func testSpokenSleepQuitsWithoutAskingTheMind() {
        var state = ready()
        let id = startListening(&state)
        state.send(.keyUp(.ask))
        let effects = state.send(.heard(id, "Go to sleep"))
        XCTAssertTrue(effects.contains(.quit))
        XCTAssertEqual(state.presentation.line, "Going to sleep.")
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.history.isEmpty)
    }

    func testSleepWorksBeforeSignInAndCancelsTheCode() {
        var (state, login) = signingIn()
        let effects = state.send(.submit(.ask, "go to sleep"))
        XCTAssertTrue(effects.contains(.quit))
        XCTAssertTrue(effects.contains(.cancel(.login)))
        XCTAssertTrue(effects.contains(.restoreClipboard))
        XCTAssertNil(state.presentation.need)
        XCTAssertEqual(state.presentation.line, "Going to sleep.")
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.send(.wake(.poll(login))), [])
    }

    func testSleepCanInterruptAQuestionAlreadyInFlight() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "A long question")))
        let effects = state.send(.submit(.ask, "go to sleep"))
        XCTAssertTrue(effects.contains(.quit))
        XCTAssertTrue(effects.contains(.cancel(.turn)))
        state.send(.replied(id, .success(reply())))
        XCTAssertEqual(state.presentation.line, "Going to sleep.")
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.history.isEmpty)
    }

    func testFailedQuitShowsAReadableWorkingRetryCard() {
        var state = ready()
        state.send(.goToSleep)
        state.send(.sleepFailed)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("couldn't go to sleep"))
        let card = state.presentation.need!
        XCTAssertEqual(card.opts.first?.label, "Try again")
        XCTAssertTrue(state.send(.answer(card, card.opts[0])).contains(.quit))
        XCTAssertEqual(state.presentation.line, "Going to sleep.")
    }

    func testFreshOwnerSeesSignInInsteadOfTheTextsPermission() {
        var state = CreatureStateMachine()
        var texts = CreatureStateMachine.permissionCard(.texts)
        texts.id = "permission-texts"
        state.send(.needsChanged([texts]))
        XCTAssertNil(state.presentation.need)
        XCTAssertFalse(state.presentation.expanded)
        let find = effectID(state.send(.findMind))
        XCTAssertEqual(state.presentation.line, "Finding my mind.")
        XCTAssertTrue(state.presentation.expanded)
        state.send(.found(find, .success(hungry)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:sign-in")
        XCTAssertTrue(state.presentation.line.contains("Sign me in"))
        XCTAssertNotEqual(state.presentation.need?.id, texts.id)
    }

    func testEveryOptionalPermissionWaitsBehindSignIn() {
        for permission in CreatureStateMachine.Permission.allCases {
            var state = ready(hungry)
            let optional = CreatureStateMachine.permissionCard(permission)
            state.send(.needsChanged([optional]))
            XCTAssertTrue(state.presentation.expanded)
            XCTAssertTrue(state.presentation.line.contains("Sign me in"))
            XCTAssertNotEqual(state.presentation.need?.id, optional.id)
        }
    }

    func testOptionalPermissionsCannotCoverAnActiveSignInCode() {
        var (state, id) = signingIn()
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.id, "creature:signing-in")
        XCTAssertTrue(state.presentation.line.contains(code.code))
        XCTAssertEqual(state.send(.wake(.poll(id))), [.pollLogin(id)])
    }

    func testDeferredPermissionAppearsImmediatelyWhenSignInFinishes() {
        var (state, id) = signingIn()
        let permission = CreatureStateMachine.permissionCard(.texts)
        state.send(.needsChanged([permission]))
        XCTAssertTrue(state.presentation.line.contains(code.code))
        state.send(.loginPolled(id, .success(LoginProgress(status: "ok"))))
        state.send(.loginConfirmed(id, .success(fed)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "You're signed in. I'm ready to help.")
        state.send(.dismissLine)
        XCTAssertEqual(state.presentation.line, permission.title)
        XCTAssertEqual(state.presentation.need, permission)
    }

    func testOptionalPermissionDoesNotHideMissingMindRecovery() {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.found(id, .failure(.unavailable)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:find")
        XCTAssertTrue(state.presentation.line.contains("can't find my mind"))
    }

    func testDeferredOptionalPermissionCannotStopAutomaticMindRecovery() {
        var state = CreatureStateMachine()
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        let id = effectID(state.send(.findMind))
        state.send(.found(id, .failure(.unavailable)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:find")
        let retry = effectID(state.send(.wake(.retry(id))))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Finding my mind.")
        state.send(.found(retry, .success(fed)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.texts))
    }

    func testFailedQuitDuringLookupDoesNotPretendTheCancelledLookupIsRunning() {
        var state = CreatureStateMachine()
        let old = effectID(state.send(.findMind))
        state.send(.goToSleep)
        state.send(.sleepFailed)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("couldn't go to sleep"))
        state.send(.later(state.presentation.need!))
        state.send(.found(old, .success(fed)))
        state.send(.submit(.ask, "Hello"))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:find")
        XCTAssertTrue(state.presentation.line.contains("can't find my mind"))
    }

    func testOptionalPermissionDoesNotHideMissingToolsRecovery() {
        var state = CreatureStateMachine()
        let id = effectID(state.send(.findMind))
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.found(id, .failure(.toolsMissing)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:install-tools")
        XCTAssertTrue(state.presentation.line.contains("Apple's tools"))
    }

    func testAutomaticMoveAdviceWaitsBehindSignIn() {
        var state = ready(hungry)
        state.send(.checkedLoginItem(.success(.moveRequired)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("Sign me in"))
        let id = effectID(state.send(.signIn))
        state.send(.loginStarted(id, .success(code)))
        XCTAssertTrue(state.presentation.line.contains(code.code))
        state.send(.loginPolled(id, .success(LoginProgress(status: "ok"))))
        state.send(.loginConfirmed(id, .success(fed)))
        XCTAssertEqual(state.presentation.line, "You're signed in. I'm ready to help.")
        state.send(.dismissLine)
        XCTAssertEqual(state.presentation.need?.id, "creature:move")
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("Applications"))
    }

    func testAutomaticStartupFailureCannotCoverTheSignInCode() {
        var (state, _) = signingIn()
        state.send(.checkedLoginItem(.failure(.unavailable)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains(code.code))
        XCTAssertEqual(state.presentation.need?.id, "creature:signing-in")
    }

    func testEarlyPermissionReleaseKeepsTheTryAgainLineExpanded() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.keyUp(.ask))
        state.send(.authorized(id, .allowed))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Ready. Hold Option and Space again to talk.")
        XCTAssertNil(state.presentation.need)
        XCTAssertTrue(state.presentation.canDismissLine)
    }

    func testEarlyPermissionReleaseMessageHasAnExplicitDismissal() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.keyUp(.ask))
        state.send(.authorized(id, .allowed))
        XCTAssertTrue(state.presentation.expanded)
        state.send(.dismissLine)
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertFalse(state.presentation.canDismissLine)
        XCTAssertEqual(state.presentation.line, "Hold Option and Space and talk to me.")
    }

    func testEmptyTranscriptExplainsHowToTryAgainInAnExpandedNotch() {
        var state = ready()
        let id = startListening(&state)
        state.send(.keyUp(.ask))
        let empty = state.send(.heard(id, " \n "))
        XCTAssertEqual(empty, [.wait(8, noticeWake(empty))])
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "I didn't catch any words. Hold Option and Space and try again.")
        XCTAssertTrue(state.presentation.canDismissLine)
        XCTAssertTrue(state.history.isEmpty)
    }

    func testLongAnswerStaysReadableAfterSpeechAndTheOldRestDelay() {
        var state = ready()
        let answer = Array(repeating: "A useful detail to read.", count: 40).joined(separator: " ")
        let id = effectID(state.send(.submit(.ask, "Explain this")))
        state.send(.replied(id, .success(reply(answer))))
        state.send(.spoken(id))
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, answer)
        XCTAssertNil(state.presentation.need)
        XCTAssertTrue(state.presentation.canDismissLine)
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, answer)
    }

    func testAnswerCanBeDismissedWithoutLosingConversationHistory() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "Question")))
        state.send(.replied(id, .success(reply("Answer"))))
        state.send(.spoken(id))
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        state.send(.dismissLine)
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Hold Option and Space and talk to me.")
        XCTAssertEqual(state.history.map { $0["content"]! }, ["Question", "Answer"])
    }

    func testSuccessfulDictationLeavesAVisibleConfirmation() {
        var state = ready()
        let id = effectID(state.send(.submit(.dictate, "These exact words")))
        state.send(.dictated(id, true))
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Typed it. These exact words")
        XCTAssertTrue(state.presentation.canDismissLine)
        XCTAssertNil(state.presentation.need)
    }

    func testNewListeningReplacesThePreviousReadableMessage() {
        var state = ready()
        let id = effectID(state.send(.submit(.ask, "Question")))
        state.send(.replied(id, .success(reply("Old answer"))))
        state.send(.spoken(id))
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.canDismissLine)
        _ = startListening(&state)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Listening.")
        XCTAssertFalse(state.presentation.canDismissLine)
        state.send(.dismissLine)
        XCTAssertEqual(state.presentation.line, "Listening.")
        XCTAssertTrue(state.presentation.expanded)
    }

    func testTypedSleepDoesNotSwallowWordsBeingDictated() {
        var state = ready()
        let effects = state.send(.submit(.dictate, "go to sleep"))
        XCTAssertFalse(effects.contains(.quit))
        XCTAssertTrue(effects.contains { if case .dictate(_, "go to sleep") = $0 { return true }; return false })
        let id = effectID(effects)
        state.send(.dictated(id, true))
        state.send(.wake(.rest(id)))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Typed it. go to sleep")
    }

    func testTypingCanBeOpenedFromTheMenuWithoutMicrophonePermission() {
        XCTAssertTrue(CreatureMenu.entries.contains { $0.command == .type })
        var state = ready()
        let typing = state.send(.showInput)
        XCTAssertEqual(typing, [.wait(8, noticeWake(typing))])
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("go to sleep"))
        XCTAssertTrue(state.presentation.canDismissLine)
        XCTAssertNil(state.presentation.need)
    }

    func testOptionalPermissionCannotCoverTheRequestedHelpCard() {
        var state = ready()
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.showHelp)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.id, "creature:help")
        XCTAssertTrue(state.presentation.line.contains("Hold Option and Space"))
        state.send(.later(state.presentation.need!))
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.texts))
        XCTAssertTrue(state.presentation.expanded)
    }

    func testOptionalPermissionWaitsUntilTheNewInstructionIsRead() {
        var state = ready()
        let id = effectID(state.send(.keyDown(.ask)))
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.keyUp(.ask))
        state.send(.authorized(id, .allowed))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.line, "Ready. Hold Option and Space again to talk.")
        XCTAssertNil(state.presentation.need)
        state.send(.dismissLine)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.texts))
    }

    func testQuitFailureCannotBeCoveredByAnotherCallersCard() {
        var state = ready()
        state.send(.needsChanged([Need(id: "caller", title: "May I make a note?",
                                      opts: [NeedOption(label: "Yes")], source: "doors")]))
        state.send(.goToSleep)
        state.send(.sleepFailed)
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.id, "creature:sleep")
        XCTAssertTrue(state.presentation.line.contains("couldn't go to sleep"))
        state.send(.later(state.presentation.need!))
        XCTAssertEqual(state.presentation.need?.id, "caller")
    }
}

extension LoginItemTests {
    func testQuitUnloadsOnlyTheLiveCreatureAndPreservesFutureStarts() throws {
        var item = try fixture(env: ["XPC_SERVICE_NAME": LoginItem.label])
        item.command = { _ in 0 }
        try item.install()
        let saved = try Data(contentsOf: Doctor.loginItemURL(home: item.home))
        var calls: [[String]] = []
        item.command = { calls.append($0); return 0 }
        try item.quit()
        XCTAssertEqual(calls.map { $0[0] }, ["print", "bootout"])
        XCTAssertTrue(calls.allSatisfy { $0[1].hasSuffix("/\(LoginItem.label)") })
        XCTAssertEqual(try Data(contentsOf: Doctor.loginItemURL(home: item.home)), saved)
        XCTAssertFalse(item.startupPreference.isStopped)
    }

    func testQuitFailureDoesNotPretendTheKeepAliveCreatureHasStopped() throws {
        var item = try fixture()
        item.command = { $0.first == "print" ? 0 : 9 }
        XCTAssertThrowsError(try item.quit()) {
            XCTAssertEqual($0 as? MindError, .serviceFailed(9))
        }
    }
}

extension StartupAdapterRegressionTests {
    func testQuitAdapterCleansUpAndUsesTheRealTerminationBoundary() async throws {
        let (effects, commands, _) = try fixture()
        commands.loaded.insert(LoginItem.label)
        var terminated = false
        effects.terminate = { terminated = true }
        let event = await effects.perform(.quit)
        XCTAssertTrue(terminated)
        XCTAssertEqual(event, .shutdown)
        XCTAssertEqual(commands.calls.map { $0[0] }, ["print", "bootout"])
        XCTAssertFalse(commands.loaded.contains(LoginItem.label))
    }

    func testQuitAdapterFailureReturnsAnExpandedRecoveryCard() async throws {
        let (effects, _, _) = try fixture()
        effects.loginItem.command = { $0.first == "print" ? 0 : 9 }
        effects.terminate = { XCTFail("Do not claim to quit while the live job would reopen us") }
        let event = await effects.perform(.quit)
        XCTAssertEqual(event, .sleepFailed)
        var state = CreatureStateMachine()
        state.send(.goToSleep)
        if let event { state.send(event) }
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertTrue(state.presentation.line.contains("couldn't go to sleep"))
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:sleep")
    }
}

extension NeedsTests {
    func testOpeningAQueuedPermissionDoesNotMakeItsCardReappear() throws {
        let queue = NeedsQueue(dir: try testDirectory(self))
        let permission = CreatureStateMachine.permissionCard(.texts)
        queue.add(permission)
        var state = CreatureStateMachine()
        let work = state.send(.findMind)
        guard case .findMind(let id) = work.last else { return XCTFail("Expected lookup") }
        state.send(.found(id, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
        state.send(.needsChanged(queue.needs))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need, permission)
        let effects = state.send(.answer(permission, permission.opts[0]))
        XCTAssertTrue(effects.contains(.answer(permission, permission.opts[0])))
        for case .answer(let need, let option) in effects { queue.answer(need, option) }
        queue.reload()
        state.send(.needsChanged(queue.needs))
        XCTAssertNil(state.presentation.need)
        XCTAssertFalse(state.presentation.expanded)
    }

    func testLaterOnAQueuedPermissionSurvivesItsNextFolderReload() throws {
        let queue = NeedsQueue(dir: try testDirectory(self))
        let permission = CreatureStateMachine.permissionCard(.texts)
        queue.add(permission)
        var state = CreatureStateMachine()
        let work = state.send(.findMind)
        guard case .findMind(let id) = work.last else { return XCTFail("Expected lookup") }
        state.send(.found(id, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
        state.send(.needsChanged(queue.needs))
        XCTAssertTrue(state.presentation.expanded)
        let effects = state.send(.later(permission))
        XCTAssertEqual(effects, [.later(permission), .cancel(.notice)])
        for case .later(let need) in effects { queue.later(need) }
        queue.reload()
        state.send(.needsChanged(queue.needs))
        XCTAssertNil(state.presentation.need)
        XCTAssertFalse(state.presentation.expanded)
    }

    func testDeferredOptionalPermissionNeverTakesItsOwnDefault() throws {
        let queue = NeedsQueue(dir: try testDirectory(self))
        var permission = CreatureStateMachine.permissionCard(.texts)
        permission.id = "permission-texts"
        permission.created = Date().timeIntervalSince1970 - 700
        queue.add(permission)
        queue.reload()
        XCTAssertEqual(queue.needs, [permission])
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.dir.appendingPathComponent("permission-texts.answer.json").path))
        var state = CreatureStateMachine()
        let work = state.send(.findMind)
        guard case .findMind(let id) = work.last else { return XCTFail("Expected lookup") }
        state.send(.needsChanged(queue.needs))
        state.send(.found(id, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need, permission)
        XCTAssertEqual(state.presentation.line, permission.title)
    }

    func testOldOptionalPermissionRemainsAnOwnerChoiceInsteadOfBeingArchived() throws {
        let queue = NeedsQueue(dir: try testDirectory(self))
        var permission = CreatureStateMachine.permissionCard(.texts)
        permission.id = "permission-texts"
        let file = queue.add(permission)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-3 * 86400)], ofItemAtPath: file.path)
        queue.reload()
        XCTAssertEqual(queue.needs, [permission])
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        var state = CreatureStateMachine()
        let work = state.send(.findMind)
        guard case .findMind(let id) = work.last else { return XCTFail("Expected lookup") }
        state.send(.found(id, .success(MindHealth(status: "ok", version: "", model: "", agentCount: 0))))
        state.send(.needsChanged(queue.needs))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(state.presentation.need?.opts.first?.label, "Open the setting")
        XCTAssertEqual(state.presentation.line, permission.title)
    }
}
