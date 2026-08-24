import XCTest
@testable import RappidField

/// A companion that starts answering and never finishes, so the driver's
/// settle deadline can be observed instead of assumed.
struct StallingChat: CompanionChatService {
    func respond(to prompt: String, companion: Companion) -> AsyncStream<ChatEvent> {
        AsyncStream { continuation in
            continuation.yield(.delta("thinking"))
            // No final event, and the stream is never finished.
        }
    }
}

/// The debug autopilot drives the app the way a finger does — and, more
/// importantly, cannot drive it any other way.
@MainActor
final class AutopilotTests: XCTestCase {
    private struct Harness {
        let driver: AutopilotDriver
        let model: AppModel
        let navigator: FieldNavigator
        let engine: GameEngine
        let mailbox: InMemoryMailbox
        let suiteName: String
        let defaults: UserDefaults
    }

    private var harnesses: [Harness] = []
    /// The wire is a strict sequence, so the tests keep a cursor like a caller.
    private var nextSeq = 0

    override func tearDown() {
        for harness in harnesses {
            harness.defaults.removePersistentDomain(forName: harness.suiteName)
        }
        harnesses.removeAll()
        super.tearDown()
    }

    private func makeHarness(
        onboarded: Bool = true,
        path: StarterPath = .canopy,
        enabled: Bool = true,
        chat: CompanionChatService = LocalCompanionChat(tickDelay: .zero)
    ) async -> Harness {
        let suiteName = "autopilot-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let model = AppModel(defaults: defaults, credentialStore: InMemoryCredentialStore())
        if onboarded {
            model.choose(path: path)
            model.completeOnboarding()
        }
        await model.bootstrap()
        let navigator = FieldNavigator(chat: ChatViewModel(service: chat))
        let player = WakeCallPlayer()
        let engine = GameEngine(model: model, navigator: navigator, player: player)
        let mailbox = InMemoryMailbox()
        let driver = AutopilotDriver(
            model: model,
            navigator: navigator,
            player: player,
            engine: engine,
            mailbox: mailbox,
            isEnabled: enabled
        )
        // Tests assert state, not choreography; the animation pause is proven
        // separately in `testAnimatedMovesSettleBeforeTheyAnswer`.
        driver.animationSettle = .zero
        let harness = Harness(
            driver: driver,
            model: model,
            navigator: navigator,
            engine: engine,
            mailbox: mailbox,
            suiteName: suiteName,
            defaults: defaults
        )
        harnesses.append(harness)
        return harness
    }

    private func commandJSON(
        _ action: String,
        id: String = UUID().uuidString,
        target: String? = nil,
        value: String? = nil,
        version: Int = 1,
        type: String = "command",
        seq: Int? = nil,
        omitSeq: Bool = false,
        extra: [String: Any] = [:]
    ) -> String {
        nextSeq += 1
        var object: [String: Any] = ["type": type, "version": version, "id": id, "action": action]
        if !omitSeq { object["seq"] = seq ?? nextSeq }
        if let target { object["target"] = target }
        if let value { object["value"] = value }
        for (key, item) in extra { object[key] = item }
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// Sends a command and requires a receipt.
    @discardableResult
    private func send(_ harness: Harness, _ payload: String) async throws -> AutopilotReceipt {
        let receipt = await harness.driver.handle(payload: payload)
        return try XCTUnwrap(receipt, "expected a receipt for \(payload)")
    }

    /// Sends a command and requires that the app said nothing at all.
    private func expectIgnored(_ harness: Harness, _ payload: String, _ message: String) async {
        let receipt = await harness.driver.handle(payload: payload)
        XCTAssertNil(receipt, message)
    }

    private func stateDictionary(_ receipt: AutopilotReceipt) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(receipt.encoded().utf8))
        let root = try XCTUnwrap(object as? [String: Any])
        return try XCTUnwrap(root["state"] as? [String: Any])
    }

    // MARK: The allowlist

    func testAllowlistExposesNoDangerousVerb() {
        let names = AutopilotAction.allCases.map { $0.rawValue.lowercased() }
        XCTAssertEqual(Set(names).count, names.count)
        for banned in [
            "eval", "exec", "shell", "script", "fetch", "http", "url", "file",
            "path", "read", "write", "delete", "token", "credential", "auth",
            "login", "tap", "click", "coordinate", "selector", "element", "query",
            "sql", "install", "keychain", "defaults",
        ] {
            XCTAssertFalse(names.contains { $0.contains(banned) }, "\"\(banned)\" must not be an autopilot verb")
        }
    }

    // MARK: Refusals

    func testMalformedCommandsAreRefusedAndChangeNothing() async throws {
        let harness = await makeHarness()
        let before = harness.driver.snapshot()

        let cases: [(String, String)] = [
            (commandJSON("navigate", target: "growth", extra: ["extra": "x"]), "malformed-payload"),
            (commandJSON("navigate", target: "growth", version: 2), "unsupported-version"),
            (commandJSON("navigate", id: "", target: "growth"), "missing-command-id"),
            (commandJSON("evaluateJavaScript"), "unknown-action"),
            (commandJSON("navigate", extra: ["target": 42]), "malformed-payload"),
            (commandJSON("navigate", target: "keychain"), "bad-target"),
            (commandJSON("navigate"), "bad-target"),
            (commandJSON("fillChatInput", value: String(repeating: "a", count: 513)), "value-rejected"),
            (
                commandJSON(
                    "snapshot",
                    id: "oversized-command",
                    value: String(repeating: "a", count: 5_000)
                ),
                "malformed-payload"
            ),
            (commandJSON("fillChatInput"), "value-missing"),
            (commandJSON("navigate", target: "growth", omitSeq: true), "missing-sequence"),
            (commandJSON("navigate", target: "growth", seq: 0), "missing-sequence"),
            (commandJSON("navigate", target: "growth", extra: ["seq": "seven"]), "missing-sequence"),
        ]

        for (payload, expected) in cases {
            let receipt = try await send(harness, payload)
            XCTAssertEqual(receipt.status, .refused, payload)
            let error = try XCTUnwrap(receipt.error)
            XCTAssertTrue(error.hasPrefix(expected), "\(payload) -> \(error)")
        }

        XCTAssertEqual(harness.driver.snapshot(), before, "a refused command must not move the app")
        XCTAssertEqual(harness.driver.executedCount, 0)
    }

    func testCommandsRefusedAtTheDoorDoNotConsumeAPlaceInTheOrder() async throws {
        let harness = await makeHarness()

        for payload in [
            commandJSON("navigate", target: "growth", omitSeq: true),
            commandJSON("navigate", target: "growth", seq: 0),
            commandJSON("evaluateJavaScript", seq: 7),
            commandJSON("navigate", target: "growth", version: 2, seq: 7),
            commandJSON("navigate", target: "growth", seq: 7, extra: ["script": "rm -rf /"]),
        ] {
            let receipt = try await send(harness, payload)
            XCTAssertEqual(receipt.status, .refused)
            XCTAssertEqual(receipt.cursor, 0, "nothing was accepted, so the cursor has not moved")
        }

        // The place those commands claimed is still free.
        let accepted = try await send(harness, commandJSON("snapshot", seq: 7))
        XCTAssertEqual(accepted.status, .ok)
        XCTAssertEqual(accepted.cursor, 7)
    }

    func testPayloadsThatAreNotOursAreIgnoredSilently() async throws {
        let harness = await makeHarness()
        let receiptPayload = AutopilotReceipt(
            id: "x",
            seq: 1,
            cursor: 1,
            status: .ok,
            state: harness.driver.snapshot(),
            error: nil
        ).encoded()

        let ignored = [
            "buy milk",
            "",
            "{\"hello\":\"world\"}",
            "[1,2,3]",
            receiptPayload,
            commandJSON("navigate", target: "growth", type: "receipt"),
            String(repeating: "{", count: 9_000),
        ]
        for payload in ignored {
            await expectIgnored(harness, payload, "the operator's own clipboard must not produce a receipt")
        }
        XCTAssertTrue(harness.mailbox.writes.isEmpty)
    }

    func testOversizedCommandUsesOnlyRootFieldsRegardlessOfOrder() async throws {
        let harness = await makeHarness()
        let rootID = "root-command-id"
        let reordered =
            #"{"value":""#
            + String(repeating: "x", count: 5_000)
            + #"","nested":{"id":"fake-id","type":"command"},"action":"snapshot","seq":9,"version":1,"type":"command","id":""#
            + rootID
            + #""}"#
        let receipt = try await send(harness, reordered)
        XCTAssertEqual(receipt.id, rootID)
        XCTAssertEqual(receipt.status, .refused)
        XCTAssertTrue(try XCTUnwrap(receipt.error).hasPrefix("malformed-payload"))

        let prose =
            #"{"example":{"type":"command","id":"not-root"},"padding":""#
            + String(repeating: "x", count: 5_000)
            + #""}"#
        await expectIgnored(
            harness,
            prose,
            "a nested command example does not claim the root command envelope",
        )
    }

    func testReplayedCommandIdIsRefusedAndNotExecutedTwice() async throws {
        let harness = await makeHarness()
        let payload = commandJSON("setLeash", id: "replay-1", value: "runApproved")

        let first = try await send(harness, payload)
        XCTAssertEqual(first.status, .ok)
        XCTAssertEqual(harness.model.leash, .runApproved)

        harness.model.setLeash(.observe)

        let second = try await send(harness, payload)
        XCTAssertEqual(second.status, .refused)
        XCTAssertEqual(second.error, "duplicate-command-id")
        XCTAssertEqual(harness.model.leash, .observe, "a replay must not re-run the command")
        XCTAssertEqual(harness.driver.executedCount, 1)
    }

    // MARK: The handshake

    func testEveryReceiptAnswersExactlyOneCommandInOrder() async throws {
        let harness = await makeHarness()
        var lastCursor = harness.driver.cursor
        XCTAssertEqual(lastCursor, 0)

        for action in ["snapshot", "beginEncounter", "inspectCompanion", "leaveEncounter", "snapshot"] {
            let payload = commandJSON(action)
            let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
            let receipt = try await send(harness, payload)

            XCTAssertEqual(receipt.id, sent["id"] as? String, "a receipt answers the command it was given")
            XCTAssertEqual(receipt.seq, sent["seq"] as? Int, "and echoes its place in the order")
            XCTAssertEqual(receipt.cursor, receipt.seq, "an accepted command moves the cursor to itself")
            XCTAssertGreaterThan(receipt.cursor, lastCursor, "the cursor only ever moves forward")
            lastCursor = receipt.cursor
        }
        XCTAssertEqual(harness.driver.cursor, lastCursor)
    }

    func testACommandOutOfOrderIsRefusedWithTheCursorToResyncFrom() async throws {
        let harness = await makeHarness()
        let first = try await send(harness, commandJSON("snapshot", seq: 10))
        XCTAssertEqual(first.status, .ok)
        XCTAssertEqual(first.cursor, 10)

        for stale in [1, 9, 10] {
            let receipt = try await send(harness, commandJSON("navigate", target: "growth", seq: stale))
            XCTAssertEqual(receipt.status, .refused, "seq \(stale) is not past the cursor")
            XCTAssertEqual(receipt.error, "stale-sequence: \(stale) is not past cursor 10")
            XCTAssertEqual(receipt.cursor, 10, "a refused command leaves the cursor where it was")
            XCTAssertEqual(receipt.state.screen, "fieldGuide", "and changes nothing")
        }

        let resumed = try await send(harness, commandJSON("navigate", target: "growth", seq: 11))
        XCTAssertEqual(resumed.status, .ok)
        XCTAssertEqual(resumed.cursor, 11)
    }

    func testARefusedMoveStillConsumesItsPlaceInTheOrder() async throws {
        let harness = await makeHarness()
        // Refused by the rules rather than at the door: the command was
        // accepted, so its sequence number is spent and cannot be reused.
        let refused = try await send(harness, commandJSON("leaveEncounter", seq: 4))
        XCTAssertEqual(refused.status, .refused)
        XCTAssertEqual(refused.cursor, 4)

        let replayedPlace = try await send(harness, commandJSON("snapshot", seq: 4))
        XCTAssertEqual(replayedPlace.status, .refused)
        XCTAssertTrue(try XCTUnwrap(replayedPlace.error).hasPrefix("stale-sequence"))
    }

    func testASecondCommandIsRefusedWhileOneIsStillRunning() async throws {
        let harness = await makeHarness(chat: StallingChat())
        harness.driver.settleTimeout = .milliseconds(800)

        // A reply that never commits keeps the first command in flight.
        harness.navigator.chat.input = "hello"
        let slow = Task { await harness.driver.handle(payload: self.commandJSON("sendChat", id: "slow-1", seq: 100)) }
        try await Task.sleep(for: .milliseconds(120))

        let interrupting = try await send(harness, commandJSON("snapshot", seq: 101))
        XCTAssertEqual(interrupting.status, .refused)
        XCTAssertTrue(try XCTUnwrap(interrupting.error).hasPrefix("busy"))

        let completed = await slow.value
        let first = try XCTUnwrap(completed)
        XCTAssertEqual(first.id, "slow-1")
        XCTAssertEqual(first.status, .error, "the stalled command timed out rather than hanging")
        harness.navigator.chat.cancel()
    }

    func testAnimatedMovesSettleBeforeTheyAnswer() async throws {
        let harness = await makeHarness()
        harness.driver.animationSettle = .milliseconds(150)

        XCTAssertTrue(AutopilotDriver.animates(.navigate))
        XCTAssertTrue(AutopilotDriver.animates(.openConfirmation))
        XCTAssertFalse(AutopilotDriver.animates(.snapshot))

        let started = ContinuousClock.now
        try await send(harness, commandJSON("navigate", target: "growth"))
        let animated = started.duration(to: .now)
        XCTAssertGreaterThan(animated, .milliseconds(140), "an animated move waits for the screen to arrive")

        let plainStart = ContinuousClock.now
        try await send(harness, commandJSON("snapshot"))
        XCTAssertLessThan(plainStart.duration(to: .now), .milliseconds(140), "reading state waits for nothing")
    }

    func testAReceiptIsWrittenOnlyOnceTheWorkHasSettled() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("navigate", target: "chat"))
        try await send(harness, commandJSON("fillChatInput", value: "What do you weigh?"))

        // No polling: the receipt itself reports the committed conversation,
        // because the driver waited for it before answering.
        let receipt = try await send(harness, commandJSON("sendChat"))
        XCTAssertEqual(receipt.status, .ok)
        XCTAssertEqual(receipt.state.chatMessages, 2, "the reply had already been revealed when the receipt was written")
        XCTAssertEqual(receipt.state.chatPhase, "idle")
        XCTAssertFalse(harness.navigator.chat.isReceiving)
    }

    func testWorkThatNeverSettlesProducesADeterministicTimeoutReceipt() async throws {
        let harness = await makeHarness(chat: StallingChat())
        harness.driver.settleTimeout = .milliseconds(400)

        try await send(harness, commandJSON("fillChatInput", value: "will never finish"))
        let receipt = try await send(harness, commandJSON("sendChat", seq: 500))

        XCTAssertEqual(receipt.status, .error, "a stall is an error, not a quiet success")
        XCTAssertTrue(try XCTUnwrap(receipt.error).hasPrefix("command-timeout"))
        XCTAssertEqual(receipt.seq, 500)
        XCTAssertEqual(receipt.cursor, 500, "the place in the order was still spent")
        XCTAssertEqual(receipt.state.chatPhase, "present", "the receipt still describes the world it gave up on")

        harness.navigator.chat.cancel()
    }

    // MARK: Inert modes

    func testGateRefusesWithoutBothLocks() {
        // Release: compiled out, flag or no flag.
        XCTAssertFalse(AutopilotGate.isEnabled(
            environment: ["RAPPID_AUTOPILOT": "1"],
            arguments: ["-RAPPID_AUTOPILOT", "1"],
            isCompiledIn: false
        ))
        // Debug without the flag.
        XCTAssertFalse(AutopilotGate.isEnabled(environment: [:], arguments: [], isCompiledIn: true))
        XCTAssertFalse(AutopilotGate.isEnabled(environment: ["RAPPID_AUTOPILOT": "0"], arguments: [], isCompiledIn: true))
        XCTAssertFalse(AutopilotGate.isEnabled(environment: [:], arguments: ["-RAPPID_AUTOPILOT"], isCompiledIn: true))
        // Debug with the flag, either form.
        XCTAssertTrue(AutopilotGate.isEnabled(environment: ["RAPPID_AUTOPILOT": "1"], arguments: [], isCompiledIn: true))
        XCTAssertTrue(AutopilotGate.isEnabled(environment: [:], arguments: ["-RAPPID_AUTOPILOT", "1"], isCompiledIn: true))
    }

    func testClipboardInboxIsASecondSeparateOptIn() {
        // Autopilot on, clipboard inbox off: receipts are published to the
        // pasteboard, but nothing reads commands from it.
        XCTAssertFalse(AutopilotGate.isClipboardInboxEnabled(
            environment: ["RAPPID_AUTOPILOT": "1"], arguments: [], isCompiledIn: true
        ))
        XCTAssertTrue(AutopilotGate.isClipboardInboxEnabled(
            environment: ["RAPPID_AUTOPILOT": "1", "RAPPID_AUTOPILOT_CLIPBOARD": "1"],
            arguments: [], isCompiledIn: true
        ))
        XCTAssertTrue(AutopilotGate.isClipboardInboxEnabled(
            environment: [:],
            arguments: ["-RAPPID_AUTOPILOT", "1", "-RAPPID_AUTOPILOT_CLIPBOARD", "1"],
            isCompiledIn: true
        ))
        // The clipboard flag alone cannot switch autopilot on.
        XCTAssertFalse(AutopilotGate.isClipboardInboxEnabled(
            environment: ["RAPPID_AUTOPILOT_CLIPBOARD": "1"], arguments: [], isCompiledIn: true
        ))
        // Release: neither flag matters.
        XCTAssertFalse(AutopilotGate.isClipboardInboxEnabled(
            environment: ["RAPPID_AUTOPILOT": "1", "RAPPID_AUTOPILOT_CLIPBOARD": "1"],
            arguments: [], isCompiledIn: false
        ))
    }

    func testDisabledDriverDoesAbsolutelyNothing() async throws {
        let harness = await makeHarness(enabled: false)
        let before = harness.driver.snapshot()

        await expectIgnored(harness, commandJSON("navigate", target: "growth"), "a disabled driver answers nothing")
        await expectIgnored(harness, commandJSON("resetSyntheticState"), "a disabled driver answers nothing")

        harness.mailbox.deliver(commandJSON("navigate", target: "growth"))
        await harness.driver.pollOnce()

        harness.driver.resume()
        XCTAssertFalse(harness.driver.isPolling, "a disabled driver never polls")
        XCTAssertTrue(harness.mailbox.writes.isEmpty, "a disabled driver never writes a receipt")
        XCTAssertEqual(harness.navigator.selectedTab, .fieldGuide)
        XCTAssertEqual(harness.driver.snapshot(), before)
        XCTAssertEqual(harness.driver.executedCount, 0)
    }

    func testSessionNeverStartsWithoutTheFlag() async throws {
        let harness = await makeHarness()
        let session = AutopilotSession()
        session.start(
            model: harness.model,
            navigator: harness.navigator,
            player: WakeCallPlayer(),
            engine: harness.engine,
            environment: [:],
            arguments: [],
            mailbox: harness.mailbox
        )
        XCTAssertFalse(session.isEnabled)
        XCTAssertNil(session.driver)
        XCTAssertTrue(harness.mailbox.writes.isEmpty)
    }

    // MARK: Carriers

    func testMailboxPollingExecutesAndPublishesAReceipt() async throws {
        let harness = await makeHarness()
        harness.mailbox.deliver(commandJSON("navigate", id: "poll-1", target: "privacy"))

        await harness.driver.pollOnce()

        XCTAssertEqual(harness.navigator.selectedTab, .privacy)
        let published = try XCTUnwrap(harness.mailbox.writes.last)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(published.utf8)) as? [String: Any])
        XCTAssertEqual(root["type"] as? String, "receipt")
        XCTAssertEqual(root["version"] as? Int, 1)
        XCTAssertEqual(root["id"] as? String, "poll-1")
        XCTAssertEqual(root["status"] as? String, "ok")
        XCTAssertNotNil(root["seq"] as? Int)
        XCTAssertEqual(root["cursor"] as? Int, root["seq"] as? Int, "an accepted command advances the cursor to its own place")

        // The driver must not react to the receipt it just wrote.
        let writes = harness.mailbox.writes.count
        await harness.driver.pollOnce()
        XCTAssertEqual(harness.mailbox.writes.count, writes)
    }

    /// The unattended carrier: a one-slot file in the app's own container,
    /// whose receipts are still published to the pasteboard.
    func testContainerMailboxSharesThePipelineAndPublishesToBothChannels() async throws {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("autopilot-test-\(UUID().uuidString)", isDirectory: true)
        let container = try ContainerFileMailbox(directory: base)
        defer { try? FileManager.default.removeItem(at: base) }

        let suiteName = "autopilot-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let model = AppModel(defaults: defaults, credentialStore: InMemoryCredentialStore())
        model.choose(path: .canopy)
        model.completeOnboarding()
        await model.bootstrap()
        let navigator = FieldNavigator(chat: ChatViewModel(service: LocalCompanionChat(tickDelay: .zero)))
        let pasteboard = InMemoryMailbox()
        let player = WakeCallPlayer()
        let driver = AutopilotDriver(
            model: model,
            navigator: navigator,
            player: player,
            engine: GameEngine(model: model, navigator: navigator, player: player),
            inboxes: [pasteboard, container],
            publishers: [pasteboard, container],
            isEnabled: true
        )
        defer { defaults.removePersistentDomain(forName: suiteName) }

        try Data(commandJSON("navigate", id: "file-1", target: "settings").utf8)
            .write(to: container.inboxURL, options: .atomic)

        await driver.pollOnce()

        XCTAssertEqual(navigator.selectedTab, .privacy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.inboxURL.path), "the mailbox is emptied when read")

        let fromPasteboard = try XCTUnwrap(pasteboard.writes.last)
        let fromFile = String(decoding: try Data(contentsOf: container.receiptURL), as: UTF8.self)
        XCTAssertEqual(fromPasteboard, fromFile, "the same receipt goes to every channel")
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(fromPasteboard.utf8)) as? [String: Any])
        XCTAssertEqual(root["id"] as? String, "file-1")
        XCTAssertEqual(root["status"] as? String, "ok")

        // Nothing is re-read once the inbox is empty.
        let writes = pasteboard.writes.count
        await driver.pollOnce()
        XCTAssertEqual(pasteboard.writes.count, writes)
    }

    func testCommandDeliveredDuringExecutionIsNotSilentlyDropped() async throws {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("autopilot-race-\(UUID().uuidString)", isDirectory: true)
        let mailbox = try ContainerFileMailbox(directory: base)
        defer { try? FileManager.default.removeItem(at: base) }
        let suiteName = "autopilot-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = AppModel(defaults: defaults, credentialStore: InMemoryCredentialStore())
        model.choose(path: .canopy)
        model.completeOnboarding()
        await model.bootstrap()
        let navigator = FieldNavigator(chat: ChatViewModel(service: StallingChat()))
        navigator.chat.input = "hello"
        let player = WakeCallPlayer()
        let driver = AutopilotDriver(
            model: model,
            navigator: navigator,
            player: player,
            engine: GameEngine(model: model, navigator: navigator, player: player),
            inboxes: [mailbox],
            publishers: [mailbox],
            isEnabled: true
        )
        driver.settleTimeout = .milliseconds(250)
        driver.animationSettle = .zero

        try Data(commandJSON("sendChat", id: "slow-file-1", seq: 100).utf8)
            .write(to: mailbox.inboxURL, options: .atomic)
        let firstPoll = Task { await driver.pollOnce() }
        try await Task.sleep(for: .milliseconds(80))
        try Data(commandJSON("snapshot", id: "queued-file-2", seq: 101).utf8)
            .write(to: mailbox.inboxURL, options: .atomic)
        await firstPoll.value
        let first = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: mailbox.receiptURL)
            ) as? [String: Any]
        )
        XCTAssertEqual(first["id"] as? String, "slow-file-1")
        await driver.pollOnce()

        let root = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: mailbox.receiptURL)
            ) as? [String: Any]
        )
        XCTAssertEqual(root["id"] as? String, "queued-file-2")
        XCTAssertEqual(root["status"] as? String, "ok")
    }

    // MARK: Semantic state

    func testSnapshotStateIsSemanticAndBounded() async throws {
        let harness = await makeHarness(path: .forge)
        try await send(harness, commandJSON("openCard", target: "forge"))
        let receipt = try await send(harness, commandJSON("snapshot"))

        XCTAssertEqual(receipt.status, .ok)
        let state = try stateDictionary(receipt)
        XCTAssertTrue(
            Set(state.keys).isSubset(of: AutopilotState.allowedKeys),
            "unexpected keys: \(Set(state.keys).subtracting(AutopilotState.allowedKeys).sorted())"
        )
        // The facts that are always stated, whatever else is absent.
        for required in [
            "screen", "onboarding", "starter", "stage", "availableActions",
            "weightComplete", "frameHeight", "origin", "pairing", "leash",
            "wakeCall", "chatPhase", "rosterCount",
        ] {
            XCTAssertNotNil(state[required], "\(required) must always be reported")
        }
        XCTAssertNil(state["weightBytes"], "an incomplete weight has no byte count, not a guessed one")
        XCTAssertNil(state["encounter"], "no encounter is open yet")
        // Opening a card refreshes the pending reading; whenever one is
        // reported it says outright that it is not authority.
        if let proposal = state["proposal"] as? [String: Any] {
            XCTAssertEqual(proposal["authoritative"] as? Bool, false)
            XCTAssertEqual(proposal["appendable"] as? Bool, false)
        }

        XCTAssertEqual(state["screen"] as? String, "fieldGuide")
        XCTAssertEqual(state["starter"] as? String, "forge")
        XCTAssertEqual(state["companion"] as? String, "Emberline")
        XCTAssertEqual(state["stage"] as? String, "Aetherwing")
        XCTAssertEqual(state["weightComplete"] as? Bool, false)
        XCTAssertEqual(state["displayHeightVersion"] as? String, "display-height/1.2")
        XCTAssertEqual(state["origin"] as? String, "synthetic")
        XCTAssertEqual(state["rosterCount"] as? Int, 3)
        XCTAssertFalse((state["availableActions"] as? [String] ?? []).isEmpty)

        // Semantic, not structural: no geometry, no view identity, no raw text.
        XCTAssertLessThan(receipt.encoded().utf8.count, 2_400, "a receipt stays a small artefact")
        for key in state.keys {
            for structural in ["bounds", "rect", "point", "coordinate", "selector", "accessibilityidentifier"] {
                XCTAssertFalse(key.lowercased().contains(structural), "\(key) looks structural")
            }
        }
    }

    func testExactWeightIsReportedForAMeasuredCompanion() async throws {
        let harness = await makeHarness(path: .canopy)
        try await send(harness, commandJSON("openCard", target: "canopy"))
        let receipt = try await send(harness, commandJSON("snapshot"))
        let state = try stateDictionary(receipt)
        XCTAssertTrue(Set(state.keys).isSubset(of: AutopilotState.allowedKeys))
        XCTAssertEqual(state["weightComplete"] as? Bool, true)
        XCTAssertEqual(
            state["weightBytes"] as? Int,
            SyntheticField.companion(for: .canopy).stats.totalWeightBytes
        )
    }

    // MARK: The confirmation stays binding

    func testAutopilotCannotAppendWithoutTheOrdinaryConfirmation() async throws {
        let harness = await makeHarness()
        let leash = try await send(harness, commandJSON("setLeash", value: "runApproved"))
        XCTAssertEqual(leash.status, .ok)
        let proposed = try await send(harness, commandJSON("requestProposal"))
        XCTAssertEqual(proposed.status, .ok)
        XCTAssertNotNil(harness.navigator.proposal)

        // No sheet open.
        let unopened = try await send(harness, commandJSON("approveAppend"))
        XCTAssertEqual(unopened.status, .refused)
        XCTAssertTrue(try XCTUnwrap(unopened.error).hasPrefix("requires-operator-confirmation"))

        let opened = try await send(harness, commandJSON("openConfirmation"))
        XCTAssertEqual(opened.status, .ok)

        // Sheet open, but the acknowledgement has not been given.
        let unacknowledged = try await send(harness, commandJSON("approveAppend"))
        XCTAssertEqual(unacknowledged.status, .refused)
        XCTAssertTrue(try XCTUnwrap(unacknowledged.error).hasPrefix("requires-operator-confirmation"))

        // Acknowledged — and still refused, by the same leash policy a finger hits.
        let proposalID = try XCTUnwrap(harness.navigator.proposal?.id)
        let acknowledged = try await send(
            harness,
            commandJSON("acknowledgeConfirmation", target: proposalID)
        )
        XCTAssertEqual(acknowledged.status, .ok)
        let approved = try await send(harness, commandJSON("approveAppend"))
        XCTAssertEqual(approved.status, .refused)
        XCTAssertEqual(approved.error, AppendRefusal.syntheticFixture.errorDescription)
        XCTAssertNil(harness.navigator.appendReceipt, "nothing was appended")
        XCTAssertFalse(harness.navigator.confirmationVisible)
    }

    func testAcknowledgementIsBoundToTheExactProposalShown() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("setLeash", value: "runApproved"))
        try await send(harness, commandJSON("requestProposal"))
        let originalID = try XCTUnwrap(harness.navigator.proposal?.id)
        try await send(harness, commandJSON("openConfirmation"))
        try await send(
            harness,
            commandJSON("acknowledgeConfirmation", target: originalID)
        )
        XCTAssertTrue(harness.navigator.confirmationAcknowledged)

        let swapped = try await send(harness, commandJSON("openCard", target: "forge"))
        XCTAssertNotEqual(harness.navigator.proposal?.id, originalID)
        XCTAssertTrue(harness.navigator.confirmationVisible)
        XCTAssertFalse(harness.navigator.confirmationAcknowledged)
        XCTAssertEqual(
            try stateDictionary(swapped)["confirmationAcknowledged"] as? Bool,
            false
        )

        let stale = try await send(
            harness,
            commandJSON("acknowledgeConfirmation", target: originalID)
        )
        XCTAssertEqual(stale.status, .refused)
        XCTAssertTrue(try XCTUnwrap(stale.error).contains("proposal changed"))

        let refused = try await send(harness, commandJSON("approveAppend"))
        XCTAssertEqual(refused.status, .refused)
        XCTAssertTrue(
            try XCTUnwrap(refused.error).hasPrefix("requires-operator-confirmation")
        )
        XCTAssertNil(harness.navigator.appendReceipt)
    }

    func testObserveLeashRefusesToProduceAProposal() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("setLeash", value: "observe"))
        let receipt = try await send(harness, commandJSON("requestProposal"))
        XCTAssertEqual(receipt.status, .refused)
        XCTAssertTrue(try XCTUnwrap(receipt.error).contains("Observe"))
        XCTAssertNil(harness.navigator.proposal)
    }

    func testCancelIsAlwaysAvailableAndClosesTheSheet() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("setLeash", value: "propose"))
        try await send(harness, commandJSON("requestProposal"))
        try await send(harness, commandJSON("openConfirmation"))
        XCTAssertTrue(harness.navigator.confirmationVisible)

        let cancelled = try await send(harness, commandJSON("cancelAppend"))
        XCTAssertEqual(cancelled.status, .ok)
        XCTAssertFalse(harness.navigator.confirmationVisible)
        XCTAssertFalse(harness.navigator.confirmationAcknowledged)

        let again = try await send(harness, commandJSON("cancelAppend"))
        XCTAssertEqual(again.status, .refused)
    }

    // MARK: Pairing

    func testPairingCommandsCarryNoCredentialIntoTheAppOrOutInAReceipt() async throws {
        let harness = await makeHarness()
        let code = "H7K2-9QMR-3TVX"

        let host = try await send(harness, commandJSON("fillPairingHost", value: "http://localhost:8787"))
        XCTAssertEqual(host.status, .ok)
        let filled = try await send(harness, commandJSON("fillPairingCode", value: code))
        XCTAssertEqual(filled.status, .ok)

        // A command cannot smuggle a token in: the grant is minted locally.
        let paired = try await send(harness, commandJSON("submitSyntheticPair", value: "ghp_pretend_oauth_token"))
        XCTAssertEqual(paired.status, .ok)
        XCTAssertTrue(harness.model.pairing.isPaired)

        let stored = try await harness.model.credentialStore.load()
        let credential = try XCTUnwrap(stored)
        XCTAssertFalse(credential.token.contains("ghp_pretend_oauth_token"), "no injected credential is ever adopted")
        XCTAssertTrue(credential.isSyntheticGrant)
        XCTAssertTrue(credential.isScopedToHabitatMethodsOnly)

        let snapshot = try await send(harness, commandJSON("snapshot"))
        for receipt in [paired, snapshot] {
            let json = receipt.encoded()
            let lowered = json.lowercased()
            for forbidden in ["token", "bearer", "secret", "ghp_", "gho_", "oauth", "synthetic-scoped-credential", "password"] {
                XCTAssertFalse(lowered.contains(forbidden), "a receipt must not carry \(forbidden): \(json)")
            }
            XCTAssertFalse(json.contains(credential.token))
            XCTAssertFalse(json.contains(credential.credentialID))
            XCTAssertFalse(json.contains(code), "the one-time code never leaves in a receipt")
            XCTAssertFalse(json.contains("localhost"), "the host address is not echoed back")
        }

        let state = try stateDictionary(paired)
        XCTAssertEqual(state["pairing"] as? String, "paired")
        XCTAssertEqual(state["pairingCodeFilled"] as? Bool, true)
        XCTAssertEqual(state["origin"] as? String, "synthetic", "a locally minted grant never makes a fixture look verified")
    }

    func testPairingValuesAreValidatedNotFetched() async throws {
        let harness = await makeHarness()
        for value in [
            "http://evil.example.com/steal",
            "http://evil.local",
            "file:///etc/passwd",
            "not a url at all",
        ] {
            let receipt = try await send(harness, commandJSON("fillPairingHost", value: value))
            XCTAssertEqual(receipt.status, .refused, value)
            XCTAssertTrue(try XCTUnwrap(receipt.error).hasPrefix("value-rejected"), value)
        }
        XCTAssertEqual(harness.navigator.pairingHostText, "http://localhost:8787", "a refused value is not stored")

        let badCode = try await send(harness, commandJSON("fillPairingCode", value: "OOOO-1111-IIII"))
        XCTAssertEqual(badCode.status, .refused)
        XCTAssertTrue(harness.navigator.pairingCodeText.isEmpty)
    }

    func testResetReturnsTheAppToAFreshSyntheticField() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("fillPairingHost", value: "http://localhost:8787"))
        try await send(harness, commandJSON("fillPairingCode", value: "H7K2-9QMR-3TVX"))
        try await send(harness, commandJSON("submitSyntheticPair"))
        try await send(harness, commandJSON("navigate", target: "growth"))
        XCTAssertTrue(harness.model.pairing.isPaired)

        let receipt = try await send(harness, commandJSON("resetSyntheticState"))
        XCTAssertEqual(receipt.status, .ok)

        let state = try stateDictionary(receipt)
        XCTAssertEqual(state["pairing"] as? String, "unpaired")
        XCTAssertEqual(state["screen"] as? String, "fieldGuide")
        XCTAssertEqual(state["rosterCount"] as? Int, 3)
        let cleared = try await harness.model.credentialStore.load()
        XCTAssertNil(cleared)
        XCTAssertTrue(harness.navigator.pairingCodeText.isEmpty)
    }

    // MARK: Chat and playback

    func testChatIsDrivenThroughTheCommittedMessagePath() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("navigate", target: "chat"))
        XCTAssertEqual(harness.navigator.selectedTab, .companion)

        let empty = try await send(harness, commandJSON("sendChat"))
        XCTAssertEqual(empty.status, .refused, "there is nothing to send yet")

        try await send(harness, commandJSON("fillChatInput", value: "Who are you?"))
        let sent = try await send(harness, commandJSON("sendChat"))
        XCTAssertEqual(sent.status, .ok)

        let deadline = Date().addingTimeInterval(5)
        while harness.navigator.chat.messages.count < 2, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }

        let receipt = try await send(harness, commandJSON("snapshot"))
        let state = try stateDictionary(receipt)
        XCTAssertEqual(state["chatMessages"] as? Int, 2)
        XCTAssertEqual(state["chatPhase"] as? String, "idle")
        XCTAssertEqual(state["chatInputFilled"] as? Bool, false)

        // The conversation itself never rides along in a receipt.
        let json = receipt.encoded()
        XCTAssertFalse(json.contains("Who are you?"))
        XCTAssertFalse(json.contains(harness.navigator.chat.messages[1].text))
    }

    func testWakeCallIsDrivenByExplicitCommandsOnly() async throws {
        let harness = await makeHarness()
        let idle = try await send(harness, commandJSON("snapshot"))
        XCTAssertEqual(try stateDictionary(idle)["wakeCall"] as? String, "idle", "nothing plays until asked")

        let played = try await send(harness, commandJSON("playWakeCall"))
        XCTAssertEqual(played.status, .ok)
        let playing = try stateDictionary(played)["wakeCall"] as? String
        XCTAssertTrue(["playing", "failed"].contains(playing ?? ""), "playback reports the truth, got \(playing ?? "nil")")

        // Stopping is only offered when something is actually sounding.
        let stopped = try await send(harness, commandJSON("stopWakeCall"))
        if playing == "playing" {
            XCTAssertEqual(stopped.status, .ok)
        } else {
            XCTAssertEqual(stopped.status, .refused)
        }
    }

    func testOnboardingIsDrivenThroughTheSameChoice() async throws {
        let harness = await makeHarness(onboarded: false)
        let blocked = try await send(harness, commandJSON("navigate", target: "growth"))
        XCTAssertEqual(blocked.status, .refused, "there is nothing to navigate to during onboarding")

        let bad = try await send(harness, commandJSON("selectStarter", target: "inferno"))
        XCTAssertEqual(bad.status, .refused)

        let selected = try await send(harness, commandJSON("selectStarter", target: "current"))
        XCTAssertEqual(selected.status, .ok)
        XCTAssertEqual(harness.navigator.onboardingStage, .confirm)
        XCTAssertFalse(harness.model.onboardingComplete, "selecting is not choosing")

        let confirmed = try await send(harness, commandJSON("confirmStarter"))
        XCTAssertEqual(confirmed.status, .ok)
        XCTAssertTrue(harness.model.onboardingComplete)
        XCTAssertEqual(harness.model.chosenPath, .current)
        XCTAssertEqual(harness.model.leash, StarterPath.current.defaultLeash)
    }

    // MARK: Playing the game

    private func availableActions(_ receipt: AutopilotReceipt) throws -> [String] {
        let state = try stateDictionary(receipt)
        return try XCTUnwrap(state["availableActions"] as? [String])
    }

    func testAgentCanPlayADiscoveryEncounterFromTheReceiptAlone() async throws {
        let harness = await makeHarness(path: .canopy)
        let opening = try await send(harness, commandJSON("snapshot"))
        XCTAssertTrue(try availableActions(opening).contains("beginEncounter"))

        var receipt = try await send(harness, commandJSON("beginEncounter"))
        XCTAssertEqual(receipt.status, .ok)

        var encounter = try XCTUnwrap(try stateDictionary(receipt)["encounter"] as? [String: Any])
        XCTAssertEqual(encounter["phase"] as? String, "open")
        XCTAssertEqual(encounter["revealedNotes"] as? Int, 0)
        XCTAssertEqual(Set(try XCTUnwrap(encounter["moves"] as? [String])), Set(EncounterMove.allCases.map(\.rawValue)))

        // Exactly what an agent would do: listen until the shape is known,
        // then close.
        var steps = 0
        while (encounter["phase"] as? String) == "open", steps < EncounterState.maxSteps {
            let revealed = encounter["revealedNotes"] as? Int ?? 0
            let move = revealed >= 2 ? "approach" : "listen"
            receipt = try await send(harness, commandJSON("encounterMove", target: move))
            XCTAssertEqual(receipt.status, .ok, move)
            encounter = try XCTUnwrap(try stateDictionary(receipt)["encounter"] as? [String: Any])
            steps += 1
        }

        XCTAssertNotEqual(encounter["phase"] as? String, "open", "an encounter always resolves")
        let state = try stateDictionary(receipt)
        if encounter["phase"] as? String == "attuned" {
            XCTAssertEqual(state["encountersResolved"] as? Int, 1)
            XCTAssertEqual(state["attunement"] as? Int, 20)
        }

        // A resolved encounter offers only leaving.
        XCTAssertFalse(try availableActions(receipt).contains("encounterMove"))
        let left = try await send(harness, commandJSON("leaveEncounter"))
        XCTAssertEqual(left.status, .ok)
        XCTAssertNil(try stateDictionary(left)["encounter"])
    }

    func testAgentCanPlayADrillFromThePublishedIntervals() async throws {
        let harness = await makeHarness(path: .current)
        var receipt = try await send(harness, commandJSON("beginTraining"))
        XCTAssertEqual(receipt.status, .ok)

        for _ in 0..<TrainingState.totalRounds {
            let drill = try XCTUnwrap(try stateDictionary(receipt)["training"] as? [String: Any])
            guard drill["phase"] as? String == "answering" else { break }
            let intervals = try XCTUnwrap(drill["intervals"] as? [Int])
            let shape = intervals.reduce(0, +)
            let answer = shape > 0 ? "extend" : (shape < 0 ? "invert" : "echo")
            receipt = try await send(harness, commandJSON("trainingAnswer", target: answer))
            XCTAssertEqual(receipt.status, .ok)
        }

        let state = try stateDictionary(receipt)
        let drill = try XCTUnwrap(state["training"] as? [String: Any])
        XCTAssertEqual(drill["phase"] as? String, "complete")
        XCTAssertEqual(drill["correct"] as? Int, TrainingState.totalRounds, "the shape is published, so a reader can win")
        XCTAssertEqual(state["drillsCompleted"] as? Int, 1)
        XCTAssertEqual(state["attunement"] as? Int, TrainingState.totalRounds * 5)

        let done = try await send(harness, commandJSON("endTraining"))
        XCTAssertNil(try stateDictionary(done)["training"])
    }

    func testAdvertisedActionsMatchWhatIsAccepted() async throws {
        let harness = await makeHarness()
        let opening = try await send(harness, commandJSON("snapshot"))
        let available = Set(try availableActions(opening))

        // Everything the game currently offers is named on the wire.
        XCTAssertTrue(available.contains("beginEncounter"))
        XCTAssertTrue(available.contains("beginTraining"))
        XCTAssertTrue(available.contains("snapshot"))

        // Nothing that is not offered will be accepted. Refusals do not move
        // the app, so these can all be tried against one harness.
        let parameterless = [
            "encounterMove", "leaveEncounter", "trainingAnswer", "endTraining",
            "openConfirmation", "acknowledgeConfirmation", "approveAppend",
            "cancelAppend", "stopWakeCall", "confirmStarter",
        ]
        for action in parameterless where !available.contains(action) {
            let target: String? = action == "encounterMove" ? "listen" : (action == "trainingAnswer" ? "echo" : nil)
            let receipt = try await send(harness, commandJSON(action, target: target))
            XCTAssertEqual(receipt.status, .refused, "\(action) is not advertised and must be refused")
        }

        // And the offer moves with the game.
        let opened = try await send(harness, commandJSON("beginEncounter"))
        let during = Set(try availableActions(opened))
        XCTAssertTrue(during.contains("encounterMove"))
        XCTAssertFalse(during.contains("beginEncounter"))
    }

    func testInspectCompanionReportsTraitsAndStatsWithoutSecrets() async throws {
        let harness = await makeHarness(path: .forge)
        let receipt = try await send(harness, commandJSON("inspectCompanion"))
        XCTAssertEqual(receipt.status, .ok)

        let state = try stateDictionary(receipt)
        let traits = try XCTUnwrap(state["traits"] as? [String: Int])
        XCTAssertEqual(Set(traits.keys), Set(StarterPath.forge.birthTraitsMilli.keys))
        for (key, value) in traits {
            XCTAssertTrue((0...1000).contains(value), "\(key) is exact thousandths")
        }
        XCTAssertEqual(state["frameHeight"] as? Int, SyntheticField.companion(for: .forge).frameHeight)
        XCTAssertEqual(state["weightComplete"] as? Bool, false)
        XCTAssertEqual(state["rappidShortHex"] as? String, SyntheticField.identity(for: .forge).shortHex)

        let json = receipt.encoded().lowercased()
        for forbidden in ["token", "bearer", "secret", "oauth"] {
            XCTAssertFalse(json.contains(forbidden))
        }
    }

    func testPlayFeedsTheProposalWithoutTouchingTheOrganism() async throws {
        let harness = await makeHarness()
        try await send(harness, commandJSON("setLeash", value: "propose"))
        let cold = try await send(harness, commandJSON("requestProposal"))
        let coldProposal = try XCTUnwrap(try stateDictionary(cold)["proposal"] as? [String: Any])
        XCTAssertEqual(coldProposal["authoritative"] as? Bool, false)
        XCTAssertEqual(coldProposal["appendable"] as? Bool, false)
        let frameBefore = try stateDictionary(cold)["frameHeight"] as? Int

        try await send(harness, commandJSON("beginTraining"))
        for _ in 0..<TrainingState.totalRounds {
            let snapshot = try await send(harness, commandJSON("snapshot"))
            guard let drill = try stateDictionary(snapshot)["training"] as? [String: Any],
                  drill["phase"] as? String == "answering",
                  let intervals = drill["intervals"] as? [Int] else { break }
            let shape = intervals.reduce(0, +)
            let answer = shape > 0 ? "extend" : (shape < 0 ? "invert" : "echo")
            try await send(harness, commandJSON("trainingAnswer", target: answer))
        }

        let warm = try await send(harness, commandJSON("requestProposal"))
        let warmState = try stateDictionary(warm)
        let warmProposal = try XCTUnwrap(warmState["proposal"] as? [String: Any])
        XCTAssertNotEqual(warmProposal["id"] as? String, coldProposal["id"] as? String, "play changes the reading")
        XCTAssertEqual(warmProposal["authoritative"] as? Bool, false, "and never its authority")
        XCTAssertEqual(warmState["frameHeight"] as? Int, frameBefore, "playing appends nothing")
        XCTAssertEqual(warmState["rappidShortHex"] as? String, try stateDictionary(cold)["rappidShortHex"] as? String)
    }
}
