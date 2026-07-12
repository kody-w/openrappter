import Foundation
@testable import OpenRappterBarLib

private struct MockTransportFailure: Error {}

private final class LockedRecorder<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value] = []

    func append(_ value: Value) {
        lock.withLock { storage.append(value) }
    }

    var values: [Value] {
        lock.withLock { storage }
    }
}

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

    await suite("Mock WebSocket — bounded sent-message waits") {
        await test("missing send times out and removes its waiter") {
            let mock = MockWebSocket(sentWaitSleeper: { _ in })

            do {
                _ = try await mock.waitForSentCount(1, timeout: .seconds(30))
                try expect(false, "missing send should fail instead of hanging")
            } catch let error as MockWebSocketWaitError {
                try expectEqual(error.expectedCount, 1)
                try expectEqual(error.actualCount, 0)
            }

            try expectEqual(mock.pendingSentWaiterCount, 0)
        }

        await test("transport cancellation drains sent-message waiters with an error") {
            let sleeper = ManualSleeper()
            let mock = MockWebSocket(sentWaitSleeper: { _ in
                try await sleeper.sleep(1)
            })
            let first = Task {
                try await mock.waitForSentCount(1, timeout: .seconds(30))
            }
            let second = Task {
                try await mock.waitForSentCount(2, timeout: .seconds(30))
            }

            _ = await sleeper.waitForScheduledCount(2)
            try expectEqual(mock.pendingSentWaiterCount, 2)
            mock.cancel()

            do {
                _ = try await first.value
                try expect(false, "cancelled transport should fail every sent-message waiter")
            } catch is CancellationError {
                // expected
            }
            do {
                _ = try await second.value
                try expect(false, "cancelled transport should drain every sent-message waiter")
            } catch is CancellationError {
                // expected
            }

            try expectEqual(mock.pendingSentWaiterCount, 0)
            await sleeper.waitForCancellationCount(2)
        }

        await test("task cancellation removes its sent-message waiter") {
            let sleeper = ManualSleeper()
            let mock = MockWebSocket(sentWaitSleeper: { _ in
                try await sleeper.sleep(1)
            })
            let waiting = Task {
                try await mock.waitForSentCount(1, timeout: .seconds(30))
            }

            _ = await sleeper.waitForScheduledCount(1)
            waiting.cancel()

            do {
                _ = try await waiting.value
                try expect(false, "cancelled wait task should not remain suspended")
            } catch is CancellationError {
                // expected
            }

            try expectEqual(mock.pendingSentWaiterCount, 0)
            await sleeper.waitForCancellationCount(1)
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
            try expectEqual(client?["version"] as? String, AppConstants.version)
            try expectEqual(client?["platform"] as? String, "macos")
            try expectEqual(client?["mode"] as? String, "menubar")

            await conn.disconnect()
        }

        await test("events dispatch to handler") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk(connId: "conn_abc"))

            let receivedEvents = AsyncCollector<String>()
            await conn.setEventHandler { event, _ in
                Task { await receivedEvents.append(event) }
            }

            try await conn.connect()

            let event: [String: Any] = [
                "type": "event",
                "event": "heartbeat",
                "payload": ["timestamp": "2025-01-01T00:00:00Z"],
            ]
            mock.enqueueReceive(try JSONSerialization.data(withJSONObject: event))

            // Await the event's actual arrival instead of guessing how long
            // the handler's fire-and-forget Task takes to land.
            let values = try await receivedEvents.waitForCount(1)
            try expectEqual(values.first, "heartbeat")

            await conn.disconnect()
        }

        await test("state change callback fires during connect") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })

            let states = AsyncCollector<ConnectionState>()
            await conn.setStateHandler { state in
                Task { await states.append(state) }
            }

            mock.enqueueReceive(try makeHelloOk(connId: "conn_xyz"))
            try await conn.connect()

            // The state handler fires from `Task { ... }` (fire-and-forget from a
            // non-async callback) — await the three states connect() is known
            // to emit (connecting/handshaking/connected) rather than guessing
            // how long their tasks take to land.
            let captured = try await states.waitForCount(3)

            try expect(captured.contains(.connecting), "Should have connecting state")
            try expect(captured.contains(.handshaking), "Should have handshaking state")
            try expect(captured.contains(.connected), "Should have connected state")

            await conn.disconnect()
        }
    }

    await suite("Gateway Connection — handshake failure cleanup") {
        await test("connect() tears down transport/receive task on a rejected handshake") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloError(requestId: "rpc-1", message: "nope"))

            do {
                try await conn.connect()
                try expect(false, "connect() should throw when the server rejects the handshake")
            } catch GatewayConnectionError.handshakeFailed(let message) {
                try expectEqual(message, "nope")
            }

            let state = await conn.state
            try expectEqual(state, .disconnected)
            try expect(mock.cancelled, "The failed attempt's transport should have been cancelled/released")
        }

        await test("a fresh connect() succeeds cleanly after a prior handshake failure") {
            let rejected = MockWebSocket()
            let retry = MockWebSocket()
            let factory = MockTransportFactory([rejected, retry])
            let conn = GatewayConnection(transportFactory: { _ in factory.make() })
            rejected.enqueueReceive(try makeHelloError(requestId: "rpc-1"))

            _ = try? await conn.connect()
            try expectEqual(await conn.state, .disconnected)

            // If the failed attempt had leaked its receive task/transport/pending
            // requests, this retry would hang (no receiver draining the queue)
            // or resolve the wrong pending request.
            retry.enqueueReceive(try makeHelloOk(connId: "conn_after_failure", requestId: "rpc-2"))
            try await conn.connect()

            try expectEqual(await conn.state, .connected)
            try expectEqual(await conn.connectionId, "conn_after_failure")

            await conn.disconnect()
        }

        await test("EOF immediately after hello never publishes connected and schedules reconnect") {
            let closedAfterHello = MockWebSocket()
            let retry = MockWebSocket()
            closedAfterHello.enqueueReceive(try makeHelloOk(connId: "stale", requestId: "rpc-1"))
            retry.enqueueReceive(try makeHelloOk(connId: "live", requestId: "rpc-2"))

            let factory = MockTransportFactory([closedAfterHello, retry])
            let sleeper = ManualSleeper()
            let afterHello = TestGate()
            let synchronousStates = LockedRecorder<ConnectionState>()
            let asyncStates = AsyncCollector<ConnectionState>()
            let conn = GatewayConnection(
                transportFactory: { _ in factory.make() },
                reconnectDelayProvider: { _ in 1 },
                reconnectSleeper: { delay in try await sleeper.sleep(delay) },
                postHandshakeHook: { await afterHello.wait() }
            )
            await conn.setStateHandler { state in
                synchronousStates.append(state)
                Task { await asyncStates.append(state) }
            }

            let initialConnect = Task { try? await conn.connect() }
            _ = try await closedAfterHello.waitForSentCount(1)
            await afterHello.waitUntilEntered()
            closedAfterHello.enqueueFailure(MockTransportFailure())
            _ = await sleeper.waitForScheduledCount(1)
            await afterHello.open()
            await initialConnect.value
            _ = try await asyncStates.waitForCount(3)

            try expectEqual(await conn.state, .reconnecting)
            try expect(
                !synchronousStates.values.contains(.connected),
                "terminal receive must invalidate the hello transport before connected is published"
            )

            await sleeper.resumeNext()
            _ = try await retry.waitForSentCount(1)
            _ = try await asyncStates.waitForCount(6)

            try expectEqual(await conn.state, .connected)
            try expectEqual(await conn.connectionId, "live")
            try expectEqual(factory.callCount, 2)

            await conn.disconnect()
        }
    }

    await suite("Gateway Connection — duplicate connect coalescing") {
        await test("overlapping connect() calls settle into exactly one connected session") {
            let firstTransport = MockWebSocket()
            let secondTransport = MockWebSocket()
            firstTransport.enqueueReceive(try makeHelloOk(connId: "conn_first", requestId: "rpc-1"))
            secondTransport.enqueueReceive(try makeHelloOk(connId: "conn_second", requestId: "rpc-2"))
            let factory = MockTransportFactory([firstTransport, secondTransport])
            let conn = GatewayConnection(transportFactory: { _ in factory.make() })

            async let first: ()? = try? conn.connect()
            async let second: ()? = try? conn.connect()
            _ = await (first, second)

            // Exactly one attempt should own the final, connected state —
            // never two overlapping live connections.
            let state = await conn.state
            try expectEqual(state, .connected)
            let connId = await conn.connectionId
            try expect(connId == "conn_first" || connId == "conn_second", "Should have a connectionId from one of the two attempts")

            await conn.disconnect()
        }

        await test("disconnect() during an in-flight connect() prevents it from resurrecting the connection") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            // Deliberately don't enqueue a handshake response — connect() will
            // be parked awaiting one, guaranteeing it is still in-flight (not
            // already completed) when disconnect() runs below.
            async let connectResult: ()? = try? conn.connect()

            // Poll (via cooperative yields, not a fixed sleep) until connect()
            // has actually reached its parked, in-flight handshake wait —
            // deterministic regardless of how fast/slow the scheduler is,
            // and guaranteed to terminate since connect() sets `.handshaking`
            // before it can ever suspend on the (never-supplied) response.
            while await conn.state != .handshaking {
                await Task.yield()
            }
            await conn.disconnect()
            _ = await connectResult

            // disconnect() must always win over a connect() attempt it
            // superseded — the attempt should not be able to resurrect the
            // connection after the fact.
            try expectEqual(await conn.state, .disconnected)
        }
    }

    await suite("Gateway Connection — reconnect lifecycle") {
        await test("failed scheduled reconnect detaches itself and schedules the next backoff") {
            let initial = MockWebSocket()
            let failedRetry = MockWebSocket()
            let successfulRetry = MockWebSocket()
            initial.enqueueReceive(try makeHelloOk(connId: "initial", requestId: "rpc-1"))
            failedRetry.enqueueFailure(MockTransportFailure())
            successfulRetry.enqueueReceive(try makeHelloOk(connId: "recovered", requestId: "rpc-3"))

            let factory = MockTransportFactory([initial, failedRetry, successfulRetry])
            let sleeper = ManualSleeper()
            let states = AsyncCollector<ConnectionState>()
            let conn = GatewayConnection(
                transportFactory: { _ in factory.make() },
                reconnectDelayProvider: { Double($0 + 1) },
                reconnectSleeper: { delay in try await sleeper.sleep(delay) }
            )
            await conn.setStateHandler { state in
                Task { await states.append(state) }
            }

            try await conn.connect()
            initial.enqueueFailure(MockTransportFailure())
            let firstBackoff = await sleeper.waitForScheduledCount(1)
            try expectEqual(firstBackoff, [1])

            await sleeper.resumeNext()
            let secondBackoff = await sleeper.waitForScheduledCount(2)
            try expectEqual(secondBackoff, [1, 2])

            await sleeper.resumeNext()
            let captured = try await states.waitForCount(10)
            try expectEqual(await conn.state, .connected)
            try expectEqual(
                captured.filter { $0 == .connected }.count,
                2,
                "state callbacks may enqueue out of order, but both connections must be published"
            )
            try expect(!captured.contains(.disconnected), "retry chain should remain in reconnecting states")
            try expectEqual(await conn.connectionId, "recovered")
            try expectEqual(factory.callCount, 3)

            await conn.disconnect()
        }

        await test("disconnect cancels a scheduled reconnect and prevents resurrection") {
            let initial = MockWebSocket()
            let staleRetry = MockWebSocket()
            initial.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
            staleRetry.enqueueReceive(try makeHelloOk(connId: "must_not_connect", requestId: "rpc-2"))

            let factory = MockTransportFactory([initial, staleRetry])
            let sleeper = ManualSleeper()
            let conn = GatewayConnection(
                transportFactory: { _ in factory.make() },
                reconnectDelayProvider: { _ in 1 },
                reconnectSleeper: { delay in try await sleeper.sleep(delay) }
            )

            try await conn.connect()
            initial.enqueueFailure(MockTransportFailure())
            _ = await sleeper.waitForScheduledCount(1)

            await conn.disconnect()
            await sleeper.waitForCancellationCount(1)
            await sleeper.resumeNext()

            try expectEqual(await conn.state, .disconnected)
            try expectNil(await conn.connectionId)
            try expectEqual(factory.callCount, 1)
        }
    }
}
