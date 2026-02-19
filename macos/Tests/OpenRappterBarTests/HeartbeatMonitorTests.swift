import Foundation
@testable import OpenRappterBarLib

func runHeartbeatMonitorTests() async {
    await suite("Heartbeat Monitor") {
        await test("initial state is healthy with no latency") {
            // Create a connection that won't actually connect (no transport)
            let conn = GatewayConnection(port: 49999)
            let rpc = RpcClient(connection: conn)
            let bus = EventBus()
            let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: bus)

            let latency = await hb.getLatency()
            try expectNil(latency, "Initial latency should be nil")

            let missed = await hb.getMissedCount()
            try expectEqual(missed, 0)

            let health = await hb.health
            try expectEqual(health, .healthy)
        }

        await test("start and stop are idempotent") {
            let conn = GatewayConnection(port: 49999)
            let rpc = RpcClient(connection: conn)
            let bus = EventBus()
            let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: bus, interval: 60)

            // Starting twice should be safe
            await hb.start()
            await hb.start()

            // Stopping twice should be safe
            await hb.stop()
            await hb.stop()
        }

        await test("event bus emits heartbeat missed on failed ping") {
            let conn = GatewayConnection(port: 49999)
            let rpc = RpcClient(connection: conn)
            let bus = EventBus()
            // Use very short interval for testing
            let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: bus, interval: 0.1, timeout: 0.1)

            // Subscribe to events before starting
            let stream = await bus.subscribe { event in
                event.name == AppEventName.heartbeatMissed
            }

            await hb.start()

            // Wait for at least one ping attempt
            var receivedMissed = false
            let timeoutTask = Task {
                try await Task.sleep(for: .seconds(2))
            }

            let checkTask = Task {
                for await _ in stream {
                    receivedMissed = true
                    break
                }
            }

            // Wait for either event or timeout
            _ = await Task {
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { _ = try? await timeoutTask.value }
                    group.addTask { await checkTask.value }
                    // Wait for first completion
                    await group.next()
                    group.cancelAll()
                }
            }.value

            await hb.stop()
            timeoutTask.cancel()
            checkTask.cancel()

            try expect(receivedMissed, "Should have received a heartbeat missed event")
        }
    }
}
