import Foundation
@testable import OpenRappterBarLib

// MARK: - Mock WebSocket Transport

struct MockWebSocketWaitError: Error, CustomStringConvertible {
    let expectedCount: Int
    let actualCount: Int

    var description: String {
        "Timed out waiting for \(expectedCount) sent message(s); got \(actualCount)"
    }
}

final class MockWebSocket: WebSocketTransport, @unchecked Sendable {
    typealias Sleeper = @Sendable (Duration) async throws -> Void

    private final class SentCountWaiter: @unchecked Sendable {
        let id: UUID
        let count: Int
        let continuation: CheckedContinuation<Void, Error>
        var timeoutTask: Task<Void, Never>?

        init(id: UUID, count: Int, continuation: CheckedContinuation<Void, Error>) {
            self.id = id
            self.count = count
            self.continuation = continuation
        }
    }

    private let lock = NSLock()
    private let sentWaitSleeper: Sleeper
    private var _sentMessages: [Data] = []
    private var _receiveQueue: [Result<Data, Error>] = []
    private var _receiveContinuation: CheckedContinuation<Data, Error>?
    private var _cancelled = false
    private var _sentCountWaiters: [SentCountWaiter] = []
    private var _registeringSentWaiterIDs: Set<UUID> = []
    private var _cancelledSentWaiterIDs: Set<UUID> = []

    init(
        sentWaitSleeper: @escaping Sleeper = { timeout in
            try await Task.sleep(for: timeout)
        }
    ) {
        self.sentWaitSleeper = sentWaitSleeper
    }

    var sentMessages: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return _sentMessages
    }

    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _cancelled
    }

    var pendingSentWaiterCount: Int {
        lock.withLock { _sentCountWaiters.count }
    }

    func send(_ data: Data) async throws {
        let ready: [SentCountWaiter] = try lock.withLock {
            if _cancelled { throw CancellationError() }
            _sentMessages.append(data)
            let count = _sentMessages.count
            let ready = _sentCountWaiters.filter { count >= $0.count }
            _sentCountWaiters.removeAll { count >= $0.count }
            return ready
        }
        for waiter in ready {
            waiter.timeoutTask?.cancel()
            waiter.continuation.resume()
        }
    }

    /// Suspends until at least `count` messages have actually landed in
    /// `sentMessages` (i.e. this mock's `send(_:)` has been called that many
    /// times), then returns them.
    ///
    /// Exists because `GatewayConnection.sendRequest` fires the transport
    /// `send()` from an unstructured `Task`, while this mock lets a test
    /// pre-enqueue the *response* before that request is ever "sent" — so a
    /// caller's `try await rpc.someCall()` can, in principle, resolve before
    /// the corresponding `send()` call has actually appended to
    /// `sentMessages`. Callers that need to assert on the exact bytes sent
    /// must await this rather than assume completion order.
    func waitForSentCount(
        _ count: Int,
        timeout: Duration = .seconds(5)
    ) async throws -> [Data] {
        let alreadySatisfied: [Data]? = try lock.withLock {
            if _sentMessages.count >= count { return _sentMessages }
            if _cancelled { throw CancellationError() }
            return nil
        }
        if let alreadySatisfied { return alreadySatisfied }
        try Task.checkCancellation()

        let id = UUID()
        _ = lock.withLock {
            _registeringSentWaiterIDs.insert(id)
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                registerSentCountWaiter(
                    id: id,
                    count: count,
                    timeout: timeout,
                    continuation: continuation
                )
            }
        } onCancel: {
            self.cancelSentCountWaiter(id: id)
        }
        return sentMessages
    }

    func receive() async throws -> Data {
        // Check-and-register must be atomic under one lock acquisition —
        // otherwise a message enqueued between the empty-queue check and
        // registering the continuation gets orphaned in `_receiveQueue`
        // while this call waits on a continuation nobody will ever resume.
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if _cancelled {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            if !_receiveQueue.isEmpty {
                let item = _receiveQueue.removeFirst()
                lock.unlock()
                continuation.resume(with: item)
                return
            }
            _receiveContinuation = continuation
            lock.unlock()
        }
    }

    func cancel() {
        let drained: (CheckedContinuation<Data, Error>?, [SentCountWaiter]) = lock.withLock {
            _cancelled = true
            let receiveContinuation = _receiveContinuation
            _receiveContinuation = nil
            let sentWaiters = _sentCountWaiters
            _sentCountWaiters.removeAll()
            _cancelledSentWaiterIDs.formUnion(_registeringSentWaiterIDs)
            return (receiveContinuation, sentWaiters)
        }
        drained.0?.resume(throwing: CancellationError())
        for waiter in drained.1 {
            waiter.timeoutTask?.cancel()
            waiter.continuation.resume(throwing: CancellationError())
        }
    }

    func enqueueReceive(_ data: Data) {
        lock.lock()
        if let cont = _receiveContinuation {
            _receiveContinuation = nil
            lock.unlock()
            cont.resume(returning: data)
        } else {
            _receiveQueue.append(.success(data))
            lock.unlock()
        }
    }

    func enqueueFailure(_ error: Error) {
        lock.lock()
        if let cont = _receiveContinuation {
            _receiveContinuation = nil
            lock.unlock()
            cont.resume(throwing: error)
        } else {
            _receiveQueue.append(.failure(error))
            lock.unlock()
        }
    }

    func lastSentJSON() -> [String: Any]? {
        guard let data = sentMessages.last else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func registerSentCountWaiter(
        id: UUID,
        count: Int,
        timeout: Duration,
        continuation: CheckedContinuation<Void, Error>
    ) {
        var waiter: SentCountWaiter?
        let immediateResult: Result<Void, Error>? = lock.withLock {
            _registeringSentWaiterIDs.remove(id)
            let registrationWasCancelled = _cancelledSentWaiterIDs.remove(id) != nil
            let wasCancelled = _cancelled || registrationWasCancelled
            if _sentMessages.count >= count {
                return .success(())
            }
            if wasCancelled {
                return .failure(CancellationError())
            }
            let newWaiter = SentCountWaiter(id: id, count: count, continuation: continuation)
            _sentCountWaiters.append(newWaiter)
            waiter = newWaiter
            return nil
        }

        if let immediateResult {
            continuation.resume(with: immediateResult)
            return
        }
        guard waiter != nil else { return }

        let sleeper = sentWaitSleeper
        let timeoutTask = Task { [weak self] in
            do {
                try await sleeper(timeout)
            } catch {
                return
            }
            self?.timeoutSentCountWaiter(id: id)
        }
        let waiterStillPending = lock.withLock {
            guard let pending = _sentCountWaiters.first(where: { $0.id == id }) else {
                return false
            }
            pending.timeoutTask = timeoutTask
            return true
        }
        if !waiterStillPending {
            timeoutTask.cancel()
        }
    }

    private func timeoutSentCountWaiter(id: UUID) {
        let result: (SentCountWaiter, Int)? = lock.withLock {
            guard let index = _sentCountWaiters.firstIndex(where: { $0.id == id }) else {
                return nil
            }
            let waiter = _sentCountWaiters.remove(at: index)
            return (waiter, _sentMessages.count)
        }
        guard let (waiter, actualCount) = result else { return }
        waiter.continuation.resume(throwing: MockWebSocketWaitError(
            expectedCount: waiter.count,
            actualCount: actualCount
        ))
    }

    private func cancelSentCountWaiter(id: UUID) {
        let waiter: SentCountWaiter? = lock.withLock {
            if let index = _sentCountWaiters.firstIndex(where: { $0.id == id }) {
                return _sentCountWaiters.remove(at: index)
            }
            if _registeringSentWaiterIDs.contains(id) {
                _cancelledSentWaiterIDs.insert(id)
            }
            return nil
        }
        waiter?.timeoutTask?.cancel()
        waiter?.continuation.resume(throwing: CancellationError())
    }
}

final class MockTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [MockWebSocket]
    private var _callCount = 0

    init(_ transports: [MockWebSocket]) {
        self.transports = transports
    }

    var callCount: Int {
        lock.withLock { _callCount }
    }

    func make() -> WebSocketTransport {
        lock.withLock {
            precondition(_callCount < transports.count, "No mock transport queued")
            defer { _callCount += 1 }
            return transports[_callCount]
        }
    }
}

// MARK: - Mock RPC Client

final class MockRpcClient: @unchecked Sendable {
    private let lock = NSLock()
    private var _pingResults: [Result<PingResponse, Error>] = []
    private var _pingCallCount = 0

    var pingCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _pingCallCount
    }

    func enqueuePingResult(_ result: Result<PingResponse, Error>) {
        lock.lock()
        _pingResults.append(result)
        lock.unlock()
    }

    func ping() async throws -> PingResponse {
        // Same rationale as MockWebSocket.send(): use `withLock` rather than
        // raw lock()/unlock() calls inside an `async` function body.
        let dequeued: Result<PingResponse, Error>? = lock.withLock {
            _pingCallCount += 1
            return _pingResults.isEmpty ? nil : _pingResults.removeFirst()
        }
        if let dequeued {
            return try dequeued.get()
        }
        return PingResponse(pong: Int(Date().timeIntervalSince1970 * 1000))
    }
}

// MARK: - Test Helpers

func makeHelloOk(connId: String = "conn_test123", requestId: String = "rpc-1") throws -> Data {
    let helloOk: [String: Any] = [
        "type": "res",
        "id": requestId,
        "ok": true,
        "payload": [
            "type": "hello-ok",
            "protocol": 3,
            "server": ["version": "1.4.0", "host": "localhost", "connId": connId],
            "features": ["methods": ["ping", "status"], "events": ["chat"]],
            "policy": ["maxPayload": 5000000, "tickIntervalMs": 30000],
        ] as [String: Any],
    ]
    return try JSONSerialization.data(withJSONObject: helloOk)
}

/// A rejected handshake response — the server declining the `connect` request.
func makeHelloError(requestId: String = "rpc-1", code: Int = 401, message: String = "unauthorized") throws -> Data {
    let helloError: [String: Any] = [
        "type": "res",
        "id": requestId,
        "ok": false,
        "error": ["code": code, "message": message],
    ]
    return try JSONSerialization.data(withJSONObject: helloError)
}
