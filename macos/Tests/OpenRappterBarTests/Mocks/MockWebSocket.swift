import Foundation
@testable import OpenRappterBarLib

// MARK: - Mock WebSocket Transport

final class MockWebSocket: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sentMessages: [Data] = []
    private var _receiveQueue: [Result<Data, Error>] = []
    private var _receiveContinuation: CheckedContinuation<Data, Error>?
    private var _cancelled = false

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

    func send(_ data: Data) async throws {
        lock.lock()
        _sentMessages.append(data)
        lock.unlock()
    }

    func receive() async throws -> Data {
        lock.lock()
        if !_receiveQueue.isEmpty {
            let item = _receiveQueue.removeFirst()
            lock.unlock()
            return try item.get()
        }
        lock.unlock()

        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            _receiveContinuation = continuation
            lock.unlock()
        }
    }

    func cancel() {
        lock.lock()
        _cancelled = true
        let cont = _receiveContinuation
        _receiveContinuation = nil
        lock.unlock()
        cont?.resume(throwing: CancellationError())
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

    func lastSentJSON() -> [String: Any]? {
        guard let data = sentMessages.last else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
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
        lock.lock()
        _pingCallCount += 1
        if !_pingResults.isEmpty {
            let result = _pingResults.removeFirst()
            lock.unlock()
            return try result.get()
        }
        lock.unlock()
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
