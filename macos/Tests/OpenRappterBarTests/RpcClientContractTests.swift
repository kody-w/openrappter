import Foundation
@testable import OpenRappterBarLib

// MARK: - RpcClient Contract Tests
//
// Proves RpcClient.swift resolves to the gateway's *canonical* RPC method
// names/params (chat/channels), guarding against regressions to the stale
// contract (`channels.get/update/delete/test/status`) that the live
// GatewayServer never registered. These tests do not touch
// GatewayConnection/AppDelegate/AppViewModel/ProcessManager — only the
// RpcClient service layer under test and its mocked transport.

/// Build a synthetic RPC response frame with an arbitrary payload, matching
/// the shape the gateway sends over the wire.
private func makeOkResponse(id: String, payload: [String: Any]) throws -> Data {
    let frame: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
    return try JSONSerialization.data(withJSONObject: frame)
}

private func makeOkArrayResponse(id: String, payload: [[String: Any]]) throws -> Data {
    let frame: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
    return try JSONSerialization.data(withJSONObject: frame)
}

/// Connects a fresh mock-backed GatewayConnection (consumes request id
/// "rpc-1" for the handshake) and returns it plus an RpcClient wrapping it,
/// ready for a first RPC call at id "rpc-2".
private func makeConnectedClient() async throws -> (GatewayConnection, MockWebSocket, RpcClient) {
    let mock = MockWebSocket()
    let conn = GatewayConnection(transportFactory: { _ in mock })
    mock.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
    try await conn.connect()
    return (conn, mock, RpcClient(connection: conn))
}

/// Awaits the request this test just issued actually landing in the mock's
/// sent-message log — message #2, since #1 is `makeConnectedClient()`'s
/// handshake `connect` request — then decodes it as JSON.
private func lastSentJSON(_ mock: MockWebSocket) async throws -> [String: Any]? {
    let messages = try await mock.waitForSentCount(2)
    guard let data = messages.last else { return nil }
    return try JSONSerialization.jsonObject(with: data) as? [String: Any]
}

/// Runs `call` concurrently and enqueues `response` on `mock` only once the
/// underlying request has actually landed in `sentMessages` (message #2 —
/// #1 is the handshake), then awaits and returns `call`'s result.
///
/// This closes a genuine race: `MockWebSocket`'s receive loop is already
/// parked waiting for the *next* message immediately after the handshake
/// completes, so enqueuing a response *before* issuing the call that's
/// supposed to consume it can let that already-parked loop dequeue and
/// discard the response before `sendRequest` has registered the pending
/// continuation for the new request's id — silently dropping the response
/// and stranding the real call to time out `AppConstants.requestTimeout`
/// seconds later. Deferring `enqueueReceive` until `waitForSentCount`
/// confirms the request was actually sent (which happens strictly after
/// `sendRequest` registers its pending continuation) makes the ordering
/// deterministic instead of racing the mock's own receive loop.
private func withDeferredResponse<T: Sendable>(
    mock: MockWebSocket,
    response: Data,
    sentCount: Int = 2,
    call: @Sendable @escaping () async throws -> T
) async throws -> T {
    async let result = call()
    _ = try await mock.waitForSentCount(sentCount)
    mock.enqueueReceive(response)
    return try await result
}

func runRpcClientContractTests() async {
    await suite("RpcClient Channel Contract") {
        await test("listChannels maps canonical status DTOs into UI channels") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let channels = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [
                    [
                        "id": "telegram",
                        "type": "telegram",
                        "connected": false,
                        "configured": true,
                        "running": true,
                    ],
                    [
                        "id": "slack",
                        "type": "slack",
                        "connected": true,
                        "configured": true,
                        "running": true,
                    ],
                ])
            ) {
                try await rpc.listChannels()
            }

            try expectEqual(channels.count, 2)
            try expectEqual(channels[0].id, "telegram")
            try expectEqual(channels[0].name, "Telegram")
            try expectEqual(channels[0].type, .telegram)
            try expect(channels[0].enabled, "running should map to enabled")
            try expectEqual(channels[0].status, .connecting)
            try expectEqual(channels[1].status, .connected)

            await conn.disconnect()
        }

        await test("listChannels preserves wrapped legacy aliases") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let channels = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "channels": [[
                        "channelId": "google-primary",
                        "channelType": "google-chat",
                        "name": "Google Chat Primary",
                        "enabled": true,
                        "status": "connected",
                    ]],
                ])
            ) {
                try await rpc.listChannels()
            }

            try expectEqual(channels.count, 1)
            try expectEqual(channels[0].id, "google-primary")
            try expectEqual(channels[0].type, .googleChat)
            try expectEqual(channels[0].name, "Google Chat Primary")
            try expect(channels[0].enabled)
            try expectEqual(channels[0].status, .connected)

            await conn.disconnect()
        }

        await test("listChannels keeps valid mixed rows and maps blank-type CLI by id") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let channels = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [
                    [
                        "id": "CLI",
                        "type": "   ",
                        "connected": true,
                        "configured": true,
                        "running": true,
                    ],
                    [
                        "id": "broken",
                        "type": 42,
                    ],
                    [
                        "id": "irc",
                        "type": "irc",
                        "configured": true,
                    ],
                    [
                        "id": "telegram",
                        "type": "telegram",
                        "connected": false,
                        "configured": true,
                        "running": false,
                    ],
                ])
            ) {
                try await rpc.listChannels()
            }

            try expectEqual(channels.count, 2)
            try expectEqual(channels[0].id, "CLI")
            try expectEqual(channels[0].type, .cli)
            try expect(channels[0].actionable, "registry-backed CLI must expose actions")
            try expect(channels[0].configurable, "registry-backed CLI must expose configuration")
            try expectEqual(channels[0].status, .connected)
            try expectEqual(channels[1].type, .telegram)

            await conn.disconnect()
        }

        await test("synthetic status-only channels hide actions unless registry-backed") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let channels = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [
                    [
                        "id": "signal",
                        "type": "signal",
                        "connected": false,
                        "configured": false,
                        "running": false,
                    ],
                    [
                        "id": "matrix",
                        "type": "matrix",
                        "connected": true,
                        "configured": true,
                        "running": true,
                    ],
                    [
                        "id": "teams",
                        "type": "teams",
                        "connected": true,
                        "configured": false,
                        "running": true,
                    ],
                    [
                        "id": "googlechat",
                        "type": "googlechat",
                        "connected": false,
                        "configured": false,
                        "running": false,
                    ],
                ])
            ) {
                try await rpc.listChannels()
            }

            try expectEqual(channels.count, 4)
            try expectEqual(channels[0].status, .disconnected)
            try expect(!channels[0].actionable)
            try expect(!channels[0].configurable)
            try expectEqual(channels[1].type, .matrix)
            try expect(channels[1].actionable, "registry-backed synthetic type must remain actionable")
            try expect(channels[1].configurable)
            try expectEqual(channels[1].status, .connected)
            try expect(!channels[2].actionable)
            try expectEqual(channels[2].status, .connected, "status-only rows must retain live status")
            try expectEqual(channels[3].type, .googleChat)
            try expect(!channels[3].actionable)

            let actionControlVisibility = await MainActor.run {
                let statusOnlyRow = ChannelRow(
                    channel: channels[0],
                    onToggle: {},
                    onTest: {},
                    onDisconnect: {}
                )
                let registryBackedRow = ChannelRow(
                    channel: channels[1],
                    onToggle: {},
                    onTest: {},
                    onDisconnect: {}
                )
                return (
                    statusOnlyRow.showsActionControls,
                    registryBackedRow.showsActionControls
                )
            }
            try expect(!actionControlVisibility.0)
            try expect(actionControlVisibility.1)

            await conn.disconnect()
        }

        await test("enableChannel calls canonical channels.connect with type param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["connected": true])
            ) {
                try await rpc.enableChannel(channelId: "telegram")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "channels.connect")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["type"] as? String, "telegram")
            try expectNil(params?["channelId"])
            try expectNil(params?["enabled"])

            await conn.disconnect()
        }

        await test("disableChannel calls canonical channels.disconnect with type param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["disconnected": true])
            ) {
                try await rpc.disableChannel(channelId: "slack")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "channels.disconnect")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["type"] as? String, "slack")

            await conn.disconnect()
        }

        await test("disconnect preserves configured channel in the canonical list") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["disconnected": true])
            ) {
                try await rpc.disableChannel(channelId: "discord")
            }

            let channels = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-3", payload: [[
                    "id": "discord",
                    "type": "discord",
                    "connected": false,
                    "configured": true,
                    "running": false,
                ]]),
                sentCount: 3
            ) {
                try await rpc.listChannels()
            }

            try expectEqual(channels.count, 1)
            try expectEqual(channels[0].id, "discord")
            try expect(!channels[0].enabled, "disconnect should stop, not remove, the configured channel")
            try expectEqual(channels[0].status, .disconnected)

            let messages = try await mock.waitForSentCount(3)
            let methods = messages.compactMap { data in
                (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["method"] as? String
            }
            try expectEqual(methods, ["connect", "channels.disconnect", "channels.list"])
            try expect(!methods.contains("channels.delete"))
            try expect(!methods.contains("channels.remove"))

            await conn.disconnect()
        }

        await test("testChannel calls canonical channels.probe with type param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["ok": true, "latencyMs": 5])
            ) {
                try await rpc.testChannel(channelId: "whatsapp")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "channels.probe")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["type"] as? String, "whatsapp")

            await conn.disconnect()
        }

        await test("testChannel throws when the inner probe reports ok false") {
            let (conn, mock, rpc) = try await makeConnectedClient()

            do {
                try await withDeferredResponse(
                    mock: mock,
                    response: try makeOkResponse(id: "rpc-2", payload: [
                        "probe": ["ok": false, "error": "Not connected"],
                    ])
                ) {
                    try await rpc.testChannel(channelId: "whatsapp")
                }
                try expect(false, "inner probe failure must not be treated as success")
            } catch RpcClientError.channelProbeFailed(let message) {
                try expectEqual(message, "Not connected")
            }

            await conn.disconnect()
        }

        await test("getChannelStatus calls canonical channels.list (not channels.status) and maps connected flag") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let status = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [
                    ["id": "telegram", "type": "telegram", "connected": true, "configured": true, "running": true, "messageCount": 0],
                ])
            ) {
                try await rpc.getChannelStatus(channelId: "telegram")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "channels.list")
            try expectEqual(status, .connected)

            await conn.disconnect()
        }

        await test("getChannelStatus maps a disconnected channel correctly") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let status = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [
                    ["id": "telegram", "type": "telegram", "connected": false, "configured": true, "running": false, "messageCount": 0],
                ])
            ) {
                try await rpc.getChannelStatus(channelId: "telegram")
            }
            try expectEqual(status, .disconnected)

            await conn.disconnect()
        }

        await test("getChannel calls canonical channels.list (not channels.get)") {
            let (conn, mock, rpc) = try await makeConnectedClient()

            // No matching channel in the list — should throw, not crash, and
            // must never have sent the stale "channels.get" method.
            do {
                _ = try await withDeferredResponse(
                    mock: mock,
                    response: try makeOkArrayResponse(id: "rpc-2", payload: [])
                ) {
                    try await rpc.getChannel(channelId: "telegram")
                }
                try expect(false, "expected getChannel to throw when channel is absent from channels.list")
            } catch {
                // expected
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "channels.list")

            await conn.disconnect()
        }
    }

    await suite("RpcClient Chat/Session Contract") {
        await test("sendChat sends chat.send with sessionKey param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            _ = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "runId": "run_1", "sessionKey": "sess_1", "status": "accepted", "acceptedAt": 1,
                ])
            ) {
                try await rpc.sendChat(message: "hi", sessionKey: "sess_1")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "chat.send")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["sessionKey"] as? String, "sess_1")

            await conn.disconnect()
        }

        await test("getSessionMessages sends chat.messages with sessionKey param (server accepts alias)") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            _ = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [])
            ) {
                try await rpc.getSessionMessages(sessionKey: "sess_1")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "chat.messages")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["sessionKey"] as? String, "sess_1")

            await conn.disconnect()
        }

        await test("deleteSession sends chat.delete with sessionKey param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["deleted": true])
            ) {
                try await rpc.deleteSession(sessionKey: "sess_1")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "chat.delete")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["sessionKey"] as? String, "sess_1")

            await conn.disconnect()
        }

        await test("abortChat sends chat.abort with sessionKey param") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["aborted": true, "runId": "run_1"])
            ) {
                try await rpc.abortChat(sessionKey: "sess_1")
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "chat.abort")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["sessionKey"] as? String, "sess_1")

            await conn.disconnect()
        }
    }
}
