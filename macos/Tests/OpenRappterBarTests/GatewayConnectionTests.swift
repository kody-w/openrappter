import Foundation
@testable import OpenRappterBarLib

// MARK: - Tests

func runGatewayConnectionTests() async throws {
    suite("Gateway Connection") {
        test("initial state is disconnected") {
            // Can't access actor state synchronously anymore — tested in async suite
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
    }

    await suite("Gateway Connection (actor)") {
        await test("initial state is disconnected") {
            let conn = GatewayConnection()
            let state = await conn.state
            try expectEqual(state, .disconnected)
            let connId = await conn.connectionId
            try expectNil(connId)
        }

        await test("disconnect sets state to disconnected") {
            let conn = GatewayConnection()
            await conn.disconnect()
            let state = await conn.state
            try expectEqual(state, .disconnected)
        }

        await test("handshake sends correct connect message") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk())

            try await conn.connect()

            let state = await conn.state
            try expectEqual(state, .connected)
            let connId = await conn.connectionId
            try expectEqual(connId, "conn_test123")

            let sent = mock.lastSentJSON()
            try expectEqual(sent?["type"] as? String, "req")
            try expectEqual(sent?["method"] as? String, "connect")

            let params = sent?["params"] as? [String: Any]
            let client = params?["client"] as? [String: Any]
            try expectEqual(client?["id"] as? String, "openrappter-bar")
            try expectEqual(client?["platform"] as? String, "macos")
            try expectEqual(client?["mode"] as? String, "menubar")

            await conn.disconnect()
        }

        await test("events dispatch to handler") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk(connId: "conn_abc"))

            var receivedEvent: String?
            let lock = NSLock()
            await conn.setEventHandler { event, _ in
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

            await conn.disconnect()
        }

        await test("state change callback fires during connect") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })

            var states: [ConnectionState] = []
            let lock = NSLock()
            await conn.setStateHandler { state in
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

            await conn.disconnect()
        }
    }
}
