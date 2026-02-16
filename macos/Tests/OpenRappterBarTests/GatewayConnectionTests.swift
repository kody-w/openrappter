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

// MARK: - Helper

private func makeHelloOk(connId: String = "conn_test123") throws -> Data {
    let helloOk: [String: Any] = [
        "type": "res",
        "id": "rpc-1",
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

// MARK: - Tests

func runGatewayConnectionTests() async throws {
    suite("Gateway Connection") {
        test("initial state is disconnected") {
            let conn = GatewayConnection()
            try expectEqual(conn.state, .disconnected)
            try expectNil(conn.connectionId)
        }

        test("backoff delay base is ~1s") {
            let delay = GatewayConnection.backoffDelay(attempt: 0)
            try expect(delay >= 0.5, "Delay \(delay) should be >= 0.5")
            try expect(delay <= 1.5, "Delay \(delay) should be <= 1.5")
        }

        test("backoff delay grows with attempts") {
            // Use multiple samples to handle jitter
            var sum0 = 0.0
            var sum3 = 0.0
            for _ in 0..<10 {
                sum0 += GatewayConnection.backoffDelay(attempt: 0)
                sum3 += GatewayConnection.backoffDelay(attempt: 3)
            }
            try expect(sum3 / 10 > sum0 / 10, "Average delay at attempt 3 should exceed attempt 0")
        }

        test("backoff delay capped at ~30s") {
            let delay = GatewayConnection.backoffDelay(attempt: 100)
            try expect(delay <= 37.5, "Delay \(delay) should be <= 37.5")
        }

        test("disconnect sets state to disconnected") {
            let conn = GatewayConnection()
            conn.disconnect()
            try expectEqual(conn.state, .disconnected)
        }
    }

    await suite("Gateway Connection (async)") {
        await test("handshake sends correct connect message") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk())

            try await conn.connect()

            try expectEqual(conn.state, .connected)
            try expectEqual(conn.connectionId, "conn_test123")

            let sent = mock.lastSentJSON()
            try expectEqual(sent?["type"] as? String, "req")
            try expectEqual(sent?["method"] as? String, "connect")

            let params = sent?["params"] as? [String: Any]
            let client = params?["client"] as? [String: Any]
            try expectEqual(client?["id"] as? String, "openrappter-bar")
            try expectEqual(client?["platform"] as? String, "macos")
            try expectEqual(client?["mode"] as? String, "menubar")

            conn.disconnect()
        }

        await test("events dispatch to handler") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk(connId: "conn_abc"))

            var receivedEvent: String?
            let lock = NSLock()
            conn.onEvent = { event, _ in
                lock.lock()
                receivedEvent = event
                lock.unlock()
            }

            try await conn.connect()

            let event: [String: Any] = [
                "type": "event",
                "event": "heartbeat",
                "payload": ["timestamp": "2025-01-01T00:00:00Z"],
            ]
            mock.enqueueReceive(try JSONSerialization.data(withJSONObject: event))

            try await Task.sleep(for: .milliseconds(100))

            lock.lock()
            let value = receivedEvent
            lock.unlock()
            try expectEqual(value, "heartbeat")

            conn.disconnect()
        }

        await test("state change callback fires during connect") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })

            var states: [ConnectionState] = []
            let lock = NSLock()
            conn.onStateChange = { state in
                lock.lock()
                states.append(state)
                lock.unlock()
            }

            mock.enqueueReceive(try makeHelloOk(connId: "conn_xyz"))
            try await conn.connect()

            lock.lock()
            let captured = states
            lock.unlock()

            try expect(captured.contains(.connecting), "Should have connecting state")
            try expect(captured.contains(.handshaking), "Should have handshaking state")
            try expect(captured.contains(.connected), "Should have connected state")

            conn.disconnect()
        }
    }
}
