import Foundation
import SwiftUI
@testable import OpenRappterBarLib

private func makeStatusResponse(requestId: String = "rpc-2") throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "type": "res",
        "id": requestId,
        "ok": true,
        "payload": [
            "running": true,
            "port": 18790,
            "connections": 1,
            "uptime": 1,
            "version": "test",
            "startedAt": "2026-01-01T00:00:00Z",
        ] as [String: Any],
    ] as [String: Any])
}

@MainActor
func runAppViewModelTests() async {
    suite("App ViewModel") {
        test("initial state is disconnected") {
            let vm = AppViewModel()
            try expectEqual(vm.connectionState, .disconnected)
            try expectEqual(vm.statusIcon, "xmark.circle")
            try expect(vm.activities.isEmpty, "Activities should be empty")
            try expectEqual(vm.chatInput, "")
            try expect(!vm.canSend, "Should not be able to send")
        }

        test("status icon when connected") {
            let vm = AppViewModel()
            vm.connectionState = .connected
            try expectEqual(vm.statusIcon, "checkmark.circle.fill")
        }

        test("status icon when connecting") {
            let vm = AppViewModel()
            vm.connectionState = .connecting
            try expectEqual(vm.statusIcon, "arrow.triangle.2.circlepath")
        }

        test("status icon when reconnecting") {
            let vm = AppViewModel()
            vm.connectionState = .reconnecting
            try expectEqual(vm.statusIcon, "arrow.clockwise")
        }

        test("canSend requires connection and input") {
            let vm = AppViewModel()
            vm.chatInput = "hello"
            try expect(!vm.canSend, "Should not send when disconnected")

            vm.connectionState = .connected
            try expect(vm.canSend, "Should send when connected with input")

            vm.chatInput = "   "
            try expect(!vm.canSend, "Should not send with whitespace-only input")
        }

        test("add activity creates item") {
            let vm = AppViewModel()
            vm.addActivity(type: .userMessage, text: "Hello")
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].text, "Hello")
            try expectEqual(vm.activities[0].type, .userMessage)
        }

        test("activity list capped at 20") {
            let vm = AppViewModel()
            for i in 0..<25 {
                vm.addActivity(type: .system, text: "Item \(i)")
            }
            try expectEqual(vm.activities.count, 20)
            try expectEqual(vm.activities[0].text, "Item 24")
        }

        test("chat delta updates streaming text via ChatViewModel") {
            let vm = AppViewModel()
            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "delta",
                "message": [
                    "role": "assistant",
                    "content": [["type": "text", "text": "Hello world"]],
                    "timestamp": 12345,
                ] as [String: Any],
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "Hello world")
            if case .streaming = vm.chatViewModel.chatState {} else {
                try expect(false, "Expected streaming state")
            }
        }

        test("chat final adds message and clears streaming") {
            let vm = AppViewModel()
            vm.chatViewModel.streamingText = "partial"

            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "final",
                "message": [
                    "role": "assistant",
                    "content": [["type": "text", "text": "Complete response"]],
                    "timestamp": 12345,
                ] as [String: Any],
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "")
            if case .idle = vm.chatViewModel.chatState {} else {
                try expect(false, "Expected idle state after final")
            }
            // Check activity log
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].text, "Complete response")
            try expectEqual(vm.activities[0].type, .assistantMessage)
            // Check ChatViewModel messages
            try expectEqual(vm.chatViewModel.messages.count, 1)
            try expectEqual(vm.chatViewModel.messages[0].content, "Complete response")
        }

        test("chat error sets error state") {
            let vm = AppViewModel()
            vm.chatViewModel.streamingText = "partial"

            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "error",
                "errorMessage": "Something went wrong",
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "")
            if case .error(let msg) = vm.chatViewModel.chatState {
                try expectEqual(msg, "Something went wrong")
            } else {
                try expect(false, "Expected error state")
            }
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].type, .error)
        }

        test("chat aborted clears streaming without surfacing an error") {
            let vm = AppViewModel()
            vm.chatViewModel.streamingText = "partial"
            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "aborted",
            ]

            vm.handleEvent(event: "chat", payload: dict)

            try expectEqual(vm.chatViewModel.streamingText, "")
            if case .idle = vm.chatViewModel.chatState {} else {
                try expect(false, "Expected idle state after abort")
            }
            try expect(vm.activities.isEmpty, "Abort should not be logged as an error")
        }

        test("heartbeat health initial state") {
            let vm = AppViewModel()
            try expectEqual(vm.heartbeatHealth, .healthy)
            try expectNil(vm.heartbeatLatency)
        }

        test("ChatViewModel initial state") {
            let vm = AppViewModel()
            try expect(vm.chatViewModel.messages.isEmpty, "Messages should be empty")
            try expectEqual(vm.chatViewModel.streamingText, "")
            try expectNil(vm.chatViewModel.currentSessionKey)
        }

        test("SessionsViewModel initial state") {
            let vm = AppViewModel()
            try expect(vm.sessionsViewModel.sessions.isEmpty, "Sessions should be empty")
            try expect(!vm.sessionsViewModel.isLoading, "Should not be loading")
        }
    }

    await suite("App ViewModel — idempotent shutdown") {
        await test("shutdown() is safe and idempotent when never connected") {
            let vm = AppViewModel()
            await vm.shutdown()
            await vm.shutdown()  // repeated call should coalesce/no-op cleanly
            try expectEqual(vm.connectionState, .disconnected)
            try expectEqual(vm.processState, .stopped)
        }

        await test("concurrent shutdown() calls join a single in-flight teardown") {
            let vm = AppViewModel()
            async let first: Void = vm.shutdown()
            async let second: Void = vm.shutdown()
            _ = await (first, second)

            try expectEqual(vm.connectionState, .disconnected)
        }

        await test("shutdown() stops fleet polling and the uptime timer") {
            let vm = AppViewModel()
            // fleetViewModel.startRefreshing() is kicked off from init(); the
            // regression this guards is that nothing ever called
            // stopRefreshing() in production, leaving the 60s polling Task
            // (and, before the fix, the heartbeat monitor) alive forever.
            await vm.shutdown()
            // A manual follow-up stop remains safe/idempotent post-shutdown.
            vm.fleetViewModel.stopRefreshing()
            try expectEqual(vm.menuBarUptime, "")
        }

        await test("disconnectFromGateway() is safe when there is nothing to disconnect") {
            let vm = AppViewModel()
            await vm.disconnectFromGateway()
            try expectEqual(vm.connectionState, .disconnected)
            try expectNil(vm.rpcClient)
        }
    }

    await suite("App ViewModel — lifecycle races") {
        await test("disconnect during handshake cancels and awaits the connect task") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            let vm = AppViewModel(
                processManager: ProcessManager(),
                eventBus: EventBus(),
                connectionFactory: { _, _ in conn }
            )
            var readyCount = 0
            vm.onRpcClientReady = { _ in readyCount += 1 }

            let connectTask = vm.connectToGateway()
            _ = try await mock.waitForSentCount(1)
            await vm.disconnectFromGateway()
            await connectTask.value

            // A response arriving after disconnect has no live receive loop
            // and cannot publish the stale client.
            mock.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
            try expectEqual(vm.connectionState, .disconnected)
            try expectNil(vm.connection)
            try expectNil(vm.rpcClient)
            try expect(!vm.childViewModelsHaveRpcClient)
            try expectEqual(readyCount, 0)
            try expect(vm.activities.allSatisfy { $0.type != .error })
            try expectEqual(await conn.state, .disconnected)
        }

        await test("connect calls coalesce only when the endpoint is identical") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            var factoryCalls = 0
            let vm = AppViewModel(
                processManager: ProcessManager(),
                eventBus: EventBus(),
                connectionFactory: { _, _ in
                    factoryCalls += 1
                    return conn
                }
            )

            let firstTask = vm.connectToGateway(host: "same.local", port: 1111)
            _ = try await mock.waitForSentCount(1)
            let joinedTask = vm.connectToGateway(host: "same.local", port: 1111)

            mock.enqueueReceive(try makeHelloOk(connId: "same", requestId: "rpc-1"))
            _ = try await mock.waitForSentCount(2)
            mock.enqueueReceive(try makeStatusResponse())
            await joinedTask.value
            await firstTask.value

            try expectEqual(factoryCalls, 1)
            try expectEqual(vm.connectionState, .connected)
            try expectEqual(await conn.connectionId, "same")

            await vm.disconnectFromGateway()
        }

        await test("connect to a different endpoint cancels and supersedes the in-flight endpoint") {
            let firstMock = MockWebSocket()
            let secondMock = MockWebSocket()
            let firstConnection = GatewayConnection(transportFactory: { _ in firstMock })
            let secondConnection = GatewayConnection(transportFactory: { _ in secondMock })
            var requestedEndpoints: [String] = []
            var nextConnection = 0
            let connections = [firstConnection, secondConnection]
            let vm = AppViewModel(
                processManager: ProcessManager(),
                eventBus: EventBus(),
                connectionFactory: { host, port in
                    requestedEndpoints.append("\(host):\(port)")
                    defer { nextConnection += 1 }
                    return connections[nextConnection]
                }
            )

            let firstTask = vm.connectToGateway(host: "first.local", port: 1111)
            _ = try await firstMock.waitForSentCount(1)

            secondMock.enqueueReceive(try makeHelloOk(connId: "second", requestId: "rpc-1"))
            let secondTask = vm.connectToGateway(host: "second.local", port: 2222)
            _ = try await secondMock.waitForSentCount(2)
            secondMock.enqueueReceive(try makeStatusResponse())

            await secondTask.value
            await firstTask.value

            try expect(firstMock.cancelled, "superseded endpoint transport should be cancelled")
            try expectEqual(requestedEndpoints, ["first.local:1111", "second.local:2222"])
            try expect(vm.connection === secondConnection)
            try expectEqual(vm.connectionState, .connected)
            try expectEqual(await firstConnection.state, .disconnected)
            try expectEqual(await secondConnection.connectionId, "second")

            await vm.disconnectFromGateway()
        }

        await test("disconnect after client publication clears every child reference") {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            let vm = AppViewModel(
                processManager: ProcessManager(),
                eventBus: EventBus(),
                connectionFactory: { _, _ in conn }
            )
            var disconnectTask: Task<Void, Never>?
            var invalidationCount = 0
            vm.onRpcClientReady = { _ in
                disconnectTask = Task { await vm.disconnectFromGateway() }
            }
            vm.onRpcClientInvalidated = {
                invalidationCount += 1
            }

            mock.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
            let connectTask = vm.connectToGateway()
            await connectTask.value
            await disconnectTask?.value

            try expectEqual(vm.connectionState, .disconnected)
            try expectNil(vm.connection)
            try expectNil(vm.rpcClient)
            try expect(!vm.childViewModelsHaveRpcClient)
            try expectEqual(invalidationCount, 1)
            try expect(vm.activities.allSatisfy { $0.type != .error })
        }

        await test("superseded gateway start never logs success or connects") {
            let detectorGate = TestGate()
            let lifecycleEvents = AsyncCollector<ProcessManager.LifecycleRequest>()
            var nodeResolverCalls = 0
            let pm = ProcessManager(
                nodePathResolver: {
                    nodeResolverCalls += 1
                    return "/bin/sh"
                },
                gatewayDetector: {
                    await detectorGate.wait()
                    return false
                },
                lifecycleObserver: { request in
                    Task { await lifecycleEvents.append(request) }
                }
            )
            let vm = AppViewModel(processManager: pm, eventBus: EventBus())

            let startTask = vm.startGateway()
            await detectorGate.waitUntilEntered()
            let stopTask = vm.stopGateway()
            _ = try await lifecycleEvents.waitForCount(2)
            await detectorGate.open()
            await startTask.value
            await stopTask.value

            try expectEqual(pm.state, .stopped)
            try expectEqual(vm.processState, .stopped)
            try expectNil(vm.connection)
            try expectEqual(nodeResolverCalls, 0)
            try expect(!vm.activities.contains { $0.text == "Gateway started" })
        }

        await test("shutdown cancels a start scheduled for a later actor turn before process launch") {
            var lifecycleRequests: [ProcessManager.LifecycleRequest] = []
            let pm = ProcessManager(
                gatewayDetector: { true },
                lifecycleObserver: { lifecycleRequests.append($0) }
            )
            let vm = AppViewModel(processManager: pm, eventBus: EventBus())

            let lateStart = vm.startGateway()
            lateStart.cancel()
            await vm.shutdown()
            await lateStart.value

            try expectEqual(lifecycleRequests, [.stop])
            try expectEqual(pm.state, .stopped)
            try expectEqual(vm.processState, .stopped)
            try expectNil(vm.connection)
            try expect(!vm.activities.contains { $0.text == "Gateway started" })
        }

        await test("shutdown does not return before the owned process terminates") {
            let stopGate = TestGate()
            let completed = AsyncCollector<Bool>()
            let pm = ProcessManager(processStopper: { proc in
                await stopGate.wait()
                proc.interrupt()
                proc.waitUntilExit()
            })
            let proc = try await spawnTrapFixture("trap 'exit 0' INT")
            pm.adoptForTesting(proc)
            let vm = AppViewModel(processManager: pm, eventBus: EventBus())
            vm.processState = .running

            let shutdownTask = Task {
                await vm.shutdown()
                await completed.append(true)
            }
            await stopGate.waitUntilEntered()
            try expect(await completed.values.isEmpty, "shutdown returned before termination was released")

            await stopGate.open()
            await shutdownTask.value

            try expect(!proc.isRunning)
            try expectEqual(pm.state, .stopped)
            try expectEqual(vm.processState, .stopped)
            try expectEqual(await completed.values, [true])
        }

        await test("authentication restart cannot outlive shutdown or restart afterward") {
            let stopGate = TestGate()
            var lifecycleEvents: [String] = []
            var nodeResolverCalls = 0
            let pm = ProcessManager(
                nodePathResolver: {
                    nodeResolverCalls += 1
                    return "/bin/sh"
                },
                processStopper: { proc in
                    await stopGate.wait()
                    proc.interrupt()
                    proc.waitUntilExit()
                    lifecycleEvents.append("managed process stopped")
                },
                lifecycleObserver: { request in
                    lifecycleEvents.append("\(request) requested")
                }
            )
            let proc = try await spawnTrapFixture("trap 'exit 0' INT")
            pm.adoptForTesting(proc)
            let vm = AppViewModel(processManager: pm, eventBus: EventBus())
            vm.processState = .running

            let restartTask = vm.restartGatewayAfterAuthentication(
                host: "auth.local",
                port: 3333
            )
            await stopGate.waitUntilEntered()
            let shutdownTask = Task { await vm.shutdown() }
            await Task.yield()
            await Task.yield()

            await stopGate.open()
            await restartTask.value
            await shutdownTask.value

            try expect(!proc.isRunning)
            try expectEqual(pm.state, .stopped)
            try expectEqual(vm.processState, .stopped)
            try expectNil(vm.connection)
            try expectEqual(nodeResolverCalls, 0)
            try expectEqual(
                lifecycleEvents,
                ["stop requested", "managed process stopped", "stop requested"],
                "shutdown's final stop must run after the cancelled restart settles"
            )
            try expect(!vm.activities.contains { $0.text == "Gateway restarted after authentication" })

            // A delayed auth callback arriving after shutdown is a no-op.
            await vm.restartGatewayAfterAuthentication(host: "late.local", port: 4444).value
            try expectEqual(
                lifecycleEvents,
                ["stop requested", "managed process stopped", "stop requested"]
            )
            try expectEqual(nodeResolverCalls, 0)
        }
    }
}
