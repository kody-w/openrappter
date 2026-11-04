import XCTest
@testable import OpenRappterCore

@MainActor
private final class FakeCreatureClock {
    private struct Sleeper {
        let deadline: Double
        let continuation: CheckedContinuation<Void, Error>
    }
    var now = 0.0
    var onSleep: (() -> Void)?
    private var sleepers: [UUID: Sleeper] = [:]
    func sleep(_ seconds: Double) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                sleepers[id] = Sleeper(deadline: now + seconds, continuation: continuation)
                let callback = onSleep; onSleep = nil; callback?()
            }
        } onCancel: {
            Task { @MainActor in
                self.sleepers.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
            }
        }
    }
    func advance(_ seconds: Double) {
        now += seconds
        for (id, sleeper) in sleepers where sleeper.deadline <= now {
            sleepers.removeValue(forKey: id)?.continuation.resume()
        }
    }
}

@MainActor
private final class FakeCreatureMind {
    var health = MindHealth(status: "unauthenticated", version: "fake", model: "fake", agentCount: 1)
    var progress = LoginProgress(status: "pending")
    var questions: [String] = []
    let answer = MindReply(text: "A short answer.", senses: ["voice": "A spoken answer."], sessionId: "fake", raw: "")
}

@MainActor
private final class FakeCreatureEars {
    var starts = 0
    var stops = 0
    var text = "What can you do?"
    var holdPermission = false
    var permissionRequested: (() -> Void)?
    var permission: CheckedContinuation<HearingPermission, Never>?
    func authorize() async -> HearingPermission {
        if !holdPermission { return .allowed }
        return await withCheckedContinuation {
            permission = $0; permissionRequested?()
        }
    }
}

@MainActor
private final class FakeCreatureWorld {
    let mind = FakeCreatureMind()
    let ears = FakeCreatureEars()
    let clock = FakeCreatureClock()
    var copiedCodes: [String] = []
    var restores = 0
    var spoken: [String] = []
    func perform(_ effect: CreatureEffect) async -> CreatureEvent? {
        switch effect {
        case .findMind(let id): return .found(id, .success(mind.health))
        case .startLogin(let id):
            return .loginStarted(id, .success(LoginCode(code: "FAKE-CODE", url: URL(string: "https://github.com/login/device")!)))
        case .pollLogin(let id): return .loginPolled(id, .success(mind.progress))
        case .confirmLogin(let id): return .loginConfirmed(id, .success(mind.health))
        case .showCode(let code): copiedCodes.append(code.code)
        case .restoreClipboard: restores += 1
        case .authorize(let id): return .authorized(id, await ears.authorize())
        case .startEars(let id): ears.starts += 1; return .earsStarted(id, true)
        case .stopEars(let id): ears.stops += 1; return .heard(id, ears.text)
        case .chat(let id, let question, _, _):
            mind.questions.append(question)
            return .replied(id, .success(mind.answer))
        case .speak(let id, let words): spoken.append(words); return .spoken(id)
        case .wait(let seconds, let wake):
            do { try await clock.sleep(seconds); return .wake(wake) } catch { return nil }
        default: break
        }
        return nil
    }
}

@MainActor
final class CreatureDriverTests: XCTestCase {
    private func reaches(_ driver: CreatureDriver, _ predicate: @escaping (CreaturePresentation) -> Bool) async {
        if predicate(driver.machine.presentation) { return }
        let arrived = expectation(description: "Creature reached expected state")
        var fulfilled = false
        driver.onChange = { view in
            if !fulfilled && predicate(view) { fulfilled = true; arrived.fulfill() }
        }
        await fulfillment(of: [arrived], timeout: 2)
        driver.onChange = nil
    }

    func testFakeMindEarsAndClockDriveWholeConversationWithoutMacWork() async {
        let world = FakeCreatureWorld()
        let driver = CreatureDriver(perform: world.perform)
        defer { driver.cancelAll() }
        driver.send(.findMind)
        await reaches(driver) { $0.hungry }
        let codeTimer = expectation(description: "Code waiting for a poll")
        world.clock.onSleep = { codeTimer.fulfill() }
        driver.send(.signIn)
        await fulfillment(of: [codeTimer], timeout: 2)
        XCTAssertTrue(driver.machine.presentation.line.contains("FAKE-CODE"))
        XCTAssertEqual(world.copiedCodes, ["FAKE-CODE"])
        let pendingTimer = expectation(description: "Pending sign-in")
        world.clock.onSleep = { pendingTimer.fulfill() }
        world.clock.advance(2)
        await fulfillment(of: [pendingTimer], timeout: 2)
        XCTAssertTrue(driver.machine.presentation.hungry)
        world.mind.progress = LoginProgress(status: "success")
        world.mind.health.status = "ok"
        world.clock.advance(2)
        await reaches(driver) { $0.posture == .idle && !$0.hungry }
        driver.send(.keyDown(.ask))
        await reaches(driver) { $0.posture == .listening }
        XCTAssertEqual(world.ears.starts, 1)
        let restTimer = expectation(description: "Answer waits before resting")
        world.clock.onSleep = { restTimer.fulfill() }
        driver.send(.keyUp(.ask))
        await fulfillment(of: [restTimer], timeout: 2)
        XCTAssertEqual(world.ears.stops, 1)
        XCTAssertEqual(world.mind.questions.count, 1)
        XCTAssertEqual(world.spoken, ["A spoken answer."])
        XCTAssertEqual(driver.machine.presentation.posture, .speaking)
        world.clock.advance(2)
        await reaches(driver) { $0.posture == .idle }
        XCTAssertEqual(driver.machine.history.count, 2)
    }

    func testFakePermissionDelayCannotLeaveMicrophoneOpen() async {
        let world = FakeCreatureWorld()
        world.mind.health.status = "ok"; world.ears.holdPermission = true
        let driver = CreatureDriver(perform: world.perform)
        defer { driver.cancelAll() }
        driver.send(.findMind)
        await reaches(driver) { $0.posture == .idle }
        let requested = expectation(description: "Permission is pending")
        world.ears.permissionRequested = { requested.fulfill() }
        driver.send(.keyDown(.ask))
        await fulfillment(of: [requested], timeout: 2)
        driver.send(.keyUp(.ask))
        world.ears.permission?.resume(returning: .allowed); world.ears.permission = nil
        await reaches(driver) { $0.posture == .idle }
        XCTAssertEqual(world.ears.starts, 0)
    }

    func testInterruptingSpeechCancelsItsOldRestClock() async {
        let world = FakeCreatureWorld()
        world.mind.health.status = "ok"
        let driver = CreatureDriver(perform: world.perform)
        defer { driver.cancelAll() }
        driver.send(.findMind)
        await reaches(driver) { $0.posture == .idle }
        let waiting = expectation(description: "Old rest timer")
        world.clock.onSleep = { waiting.fulfill() }
        driver.send(.submit(.ask, "Hello"))
        await fulfillment(of: [waiting], timeout: 2)
        driver.send(.keyDown(.ask))
        await reaches(driver) { $0.posture == .listening }
        world.clock.advance(20)
        await Task.yield()
        XCTAssertEqual(driver.machine.presentation.posture, .listening)
        XCTAssertEqual(world.ears.starts, 1)
    }

    func testWaitingForWorkPreservesSequentialDemoEntryPoints() async {
        let world = FakeCreatureWorld()
        world.mind.health.status = "ok"
        let driver = CreatureDriver(perform: world.perform)
        defer { driver.cancelAll() }
        driver.send(.findMind)
        await driver.waitUntilSettled()
        XCTAssertEqual(driver.machine.presentation.posture, .idle)
        let waiting = expectation(description: "Answer waits to rest")
        world.clock.onSleep = { waiting.fulfill() }
        driver.send(.submit(.ask, "First"))
        var finished = false
        let work = Task { await driver.waitUntilSettled(); finished = true }
        await fulfillment(of: [waiting], timeout: 2)
        XCTAssertFalse(finished)
        world.clock.advance(2)
        await work.value
        XCTAssertTrue(finished)
        XCTAssertEqual(driver.machine.presentation.posture, .idle)
        XCTAssertEqual(driver.machine.history.first?["content"], "First")
    }
}
