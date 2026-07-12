import Foundation

// Minimal test harness — no framework dependencies
var _testsPassed = 0
var _testsFailed = 0
var _currentSuite = ""

/// Deterministic collector for values captured by concurrently-invoked,
/// non-async callbacks in tests (e.g. `GatewayConnection` event/state
/// handlers, which fire from a fire-and-forget `Task { ... }` spawned inside
/// a synchronous callback). Actor isolation replaces ad-hoc `NSLock`
/// mutation of a captured `var`.
///
/// Unlike a plain box, this lets a test `await` the actual arrival of N
/// values via `waitForCount(_:)` instead of guessing a fixed sleep duration
/// for the callback's spawned Task to land — the wait resolves the instant
/// the Nth value is appended, whether that takes one scheduler hop or many.
actor AsyncCollector<T: Sendable> {
    typealias Sleeper = @Sendable (Duration) async throws -> Void

    private struct Waiter {
        let id: UUID
        let count: Int
        let continuation: CheckedContinuation<Void, Error>
        let timeoutTask: Task<Void, Never>
    }

    private(set) var values: [T] = []
    private var waiters: [Waiter] = []
    private let sleeper: Sleeper

    init(
        sleeper: @escaping Sleeper = { timeout in
            try await Task.sleep(for: timeout)
        }
    ) {
        self.sleeper = sleeper
    }

    func append(_ item: T) {
        values.append(item)
        let count = values.count
        let ready = waiters.filter { count >= $0.count }
        waiters.removeAll { count >= $0.count }
        for waiter in ready {
            waiter.timeoutTask.cancel()
            waiter.continuation.resume()
        }
    }

    /// Suspends until at least `count` items have been appended, then
    /// returns all values collected so far. Throws if `timeout` elapses
    /// first — a hang here means the production callback never fired at
    /// all, which the test should surface as a fast, explicit failure
    /// rather than block indefinitely.
    @discardableResult
    func waitForCount(_ count: Int, timeout: Duration = .seconds(5)) async throws -> [T] {
        if values.count >= count { return values }
        try Task.checkCancellation()

        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                register(
                    id: id,
                    count: count,
                    timeout: timeout,
                    continuation: continuation
                )
            }
        } onCancel: {
            Task { await self.cancelWaiter(id: id) }
        }
        return values
    }

    var pendingWaiterCount: Int {
        waiters.count
    }

    private func register(
        id: UUID,
        count: Int,
        timeout: Duration,
        continuation: CheckedContinuation<Void, Error>
    ) {
        if values.count >= count {
            continuation.resume()
        } else {
            let sleeper = self.sleeper
            let timeoutTask = Task { [weak self] in
                do {
                    try await sleeper(timeout)
                } catch {
                    return
                }
                await self?.timeoutWaiter(id: id)
            }
            waiters.append(Waiter(
                id: id,
                count: count,
                continuation: continuation,
                timeoutTask: timeoutTask
            ))
        }
    }

    private func timeoutWaiter(id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        waiter.timeoutTask.cancel()
        waiter.continuation.resume(throwing: AssertionError(
            description: "AsyncCollector timed out waiting for \(waiter.count) item(s); got \(values.count)"
        ))
    }

    private func cancelWaiter(id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        waiter.timeoutTask.cancel()
        waiter.continuation.resume(throwing: CancellationError())
    }
}

actor TestGate {
    private var isOpen = false
    private var enteredCount = 0
    private var blocked: [CheckedContinuation<Void, Never>] = []
    private var entryWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func wait() async {
        enteredCount += 1
        let reached = entryWaiters.filter { enteredCount >= $0.0 }
        entryWaiters.removeAll { enteredCount >= $0.0 }
        reached.forEach { $0.1.resume() }

        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            blocked.append(continuation)
        }
    }

    func waitUntilEntered(_ count: Int = 1) async {
        guard enteredCount < count else { return }
        await withCheckedContinuation { continuation in
            entryWaiters.append((count, continuation))
        }
    }

    func open() {
        isOpen = true
        let continuations = blocked
        blocked.removeAll()
        continuations.forEach { $0.resume() }
    }
}

actor ManualSleeper {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    private var waiters: [Waiter] = []
    private var scheduledWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancelledWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var scheduledDelays: [TimeInterval] = []
    private(set) var cancellationCount = 0

    func sleep(_ delay: TimeInterval) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                register(id: id, delay: delay, continuation: continuation)
            }
        } onCancel: {
            Task { await self.cancel(id: id) }
        }
    }

    func waitForScheduledCount(_ count: Int) async -> [TimeInterval] {
        if scheduledDelays.count >= count { return scheduledDelays }
        await withCheckedContinuation { continuation in
            scheduledWaiters.append((count, continuation))
        }
        return scheduledDelays
    }

    func waitForCancellationCount(_ count: Int) async {
        guard cancellationCount < count else { return }
        await withCheckedContinuation { continuation in
            cancelledWaiters.append((count, continuation))
        }
    }

    func resumeNext() {
        guard !waiters.isEmpty else { return }
        waiters.removeFirst().continuation.resume()
    }

    private func register(
        id: UUID,
        delay: TimeInterval,
        continuation: CheckedContinuation<Void, Error>
    ) {
        waiters.append(Waiter(id: id, continuation: continuation))
        scheduledDelays.append(delay)
        let ready = scheduledWaiters.filter { scheduledDelays.count >= $0.0 }
        scheduledWaiters.removeAll { scheduledDelays.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }

    private func cancel(id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        cancellationCount += 1
        waiter.continuation.resume(throwing: CancellationError())
        let ready = cancelledWaiters.filter { cancellationCount >= $0.0 }
        cancelledWaiters.removeAll { cancellationCount >= $0.0 }
        ready.forEach { $0.1.resume() }
    }
}

func suite(_ name: String, _ block: () throws -> Void) {
    _currentSuite = name
    print("Suite: \(name)")
    do {
        try block()
    } catch {
        _testsFailed += 1
        print("  FAIL (exception): \(error)")
    }
}

func suite(_ name: String, _ block: () async throws -> Void) async {
    _currentSuite = name
    print("Suite: \(name)")
    do {
        try await block()
    } catch {
        _testsFailed += 1
        print("  FAIL (exception): \(error)")
    }
}

func test(_ name: String, _ block: () throws -> Void) {
    do {
        try block()
        _testsPassed += 1
        print("  PASS: \(name)")
    } catch {
        _testsFailed += 1
        print("  FAIL: \(name) — \(error)")
    }
}

func test(_ name: String, _ block: () async throws -> Void) async {
    do {
        try await block()
        _testsPassed += 1
        print("  PASS: \(name)")
    } catch {
        _testsFailed += 1
        print("  FAIL: \(name) — \(error)")
    }
}

struct AssertionError: Error, CustomStringConvertible {
    let description: String
}

func expect(_ condition: Bool, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if !condition {
        let msg = message.isEmpty ? "Assertion failed at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if a != b {
        let msg = message.isEmpty ? "Expected \(a) == \(b) at \(file):\(line)" : "\(message): \(a) != \(b)"
        throw AssertionError(description: msg)
    }
}

func expectNil<T>(_ value: T?, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if value != nil {
        let msg = message.isEmpty ? "Expected nil at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func expectNotNil<T>(_ value: T?, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if value == nil {
        let msg = message.isEmpty ? "Expected non-nil at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func printResults() {
    print("\n========================================")
    print("Results: \(_testsPassed) passed, \(_testsFailed) failed, \(_testsPassed + _testsFailed) total")
    print("========================================")
}

func exitWithCode() {
    exit(_testsFailed > 0 ? 1 : 0)
}
