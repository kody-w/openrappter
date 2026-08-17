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

private func makeOkNullResponse(id: String) throws -> Data {
    let frame: [String: Any] = [
        "type": "res",
        "id": id,
        "ok": true,
        "payload": NSNull(),
    ]
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
    await suite("RpcClient Gateway Auth Contract") {
        await test("auth login uses the gateway device-flow method") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let login = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "userCode": "ABCD-EFGH",
                    "verificationUri": "https://github.com/login/device",
                    "deviceCode": "device-1",
                ])
            ) {
                try await rpc.beginGatewayAuthentication()
            }

            try expectEqual(login.userCode, "ABCD-EFGH")
            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "auth.login")
            await conn.disconnect()
        }

        await test("auth polling sends the gateway device code") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let poll = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "status": "pending",
                ])
            ) {
                try await rpc.pollGatewayAuthentication(deviceCode: "device-2")
            }

            try expectEqual(poll.status, "pending")
            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "auth.poll")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["deviceCode"] as? String, "device-2")
            await conn.disconnect()
        }

        await test("auth cancellation targets the pending gateway flow") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let cancelled = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "ok": true,
                    "status": "cancelled",
                ])
            ) {
                try await rpc.cancelGatewayAuthentication(deviceCode: "device-3")
            }

            try expect(cancelled.ok, "Gateway should acknowledge cancellation")
            try expectEqual(cancelled.status, "cancelled")
            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "auth.cancel")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["deviceCode"] as? String, "device-3")
            await conn.disconnect()
        }

        await test("active auth profile decodes the gateway authority") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let profile = try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "id": "octocat",
                    "username": "octocat",
                    "provider": "copilot",
                    "type": "device-code",
                    "default": true,
                    "createdAt": "2026-08-15T00:00:00Z",
                ])
            ) {
                try await rpc.activeGatewayAuthProfile()
            }

            try expectEqual(profile?.id, "octocat")
            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "auth.active")
            await conn.disconnect()
        }

        await test("active auth profile accepts the gateway's null signed-out state") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let profile = try await withDeferredResponse(
                mock: mock,
                response: try makeOkNullResponse(id: "rpc-2")
            ) {
                try await rpc.activeGatewayAuthProfile()
            }

            try expectNil(profile)
            await conn.disconnect()
        }

        await test("auth removal and switching use gateway profile methods") {
            let (removeConn, removeMock, removeRpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: removeMock,
                response: try makeOkResponse(id: "rpc-2", payload: ["ok": true])
            ) {
                try await removeRpc.removeGatewayAuthProfile(id: "octocat")
            }
            var sent = try await lastSentJSON(removeMock)
            try expectEqual(sent?["method"] as? String, "auth.remove")
            try expectEqual(
                (sent?["params"] as? [String: Any])?["id"] as? String,
                "octocat"
            )
            await removeConn.disconnect()

            let (switchConn, switchMock, switchRpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: switchMock,
                response: try makeOkResponse(id: "rpc-2", payload: ["ok": true])
            ) {
                try await switchRpc.switchGatewayAuthProfile(id: "hubot")
            }
            sent = try await lastSentJSON(switchMock)
            try expectEqual(sent?["method"] as? String, "auth.switch")
            try expectEqual(
                (sent?["params"] as? [String: Any])?["id"] as? String,
                "hubot"
            )
            await switchConn.disconnect()
        }
    }

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

    await suite("RpcClient Cron Contract") {
        // The gateway calls a cron job's prompt `message` — CronJobCreate,
        // the scheduler, and `execute(agentId, message)` all say so. This
        // client sent `command`, so every job the Bar created was scheduled
        // successfully and then fired forever with an empty prompt.
        await test("createCronJob sends cron.create with the gateway's `message` field") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: ["id": "job_1", "scheduled": true])
            ) {
                try await rpc.createCronJob(
                    name: "morning brief",
                    schedule: "0 8 * * *",
                    command: "summarise my inbox"
                )
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "cron.create")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["message"] as? String, "summarise my inbox")
            try expectEqual(params?["name"] as? String, "morning brief")
            try expectEqual(params?["schedule"] as? String, "0 8 * * *")
            await conn.disconnect()
        }

        // `nextRun` is the tell. `listCronJobs` has a hand-rolled fallback
        // parser for listings the decoder rejects, and that fallback only
        // recovers id/name/schedule/command/enabled — every schedule time is
        // silently dropped. Decoding both spellings properly is what keeps a
        // job's next run visible.
        await test("a listing that names the prompt `message` decodes without losing run times") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let jobs = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [[
                    "id": "job_1",
                    "name": "morning brief",
                    "schedule": "0 8 * * *",
                    "message": "summarise my inbox",
                    "enabled": true,
                    "nextRun": "2026-08-17T08:00:00.000Z",
                ]])
            ) {
                try await rpc.listCronJobs()
            }

            try expectEqual(jobs.count, 1)
            try expectEqual(jobs.first?.command, "summarise my inbox")
            try expectNotNil(jobs.first?.nextRun)
            await conn.disconnect()
        }

        await test("a listing that names the prompt `command` still decodes") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let jobs = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [[
                    "id": "job_1",
                    "name": "morning brief",
                    "schedule": "0 8 * * *",
                    "command": "summarise my inbox",
                    "enabled": true,
                ]])
            ) {
                try await rpc.listCronJobs()
            }

            try expectEqual(jobs.count, 1)
            try expectEqual(jobs.first?.command, "summarise my inbox")
            await conn.disconnect()
        }
    }

    // The Bar's approval screen was dead: `exec.pending` and `exec.respond`
    // were never registered on the production gateway. Now that they are, these
    // pin the wire shape the gateway emits to what RpcClient actually decodes —
    // including the ISO-8601 `timestamp`, which the stock JSONDecoder date
    // strategy rejects (it wants a Double), and which the old `try?` swallowed
    // into an empty list: an approval screen that shows nothing, forever.
    await suite("RpcClient Execution Approval Contract") {
        await test("pending approvals decode the gateway's real payload") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let approvals = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [[
                    "id": "token_1786932956639_v2wdh9c9wgs",
                    "command": "curl https://example.com",
                    "description": "Approval token issued for: curl https://example.com",
                    "timestamp": "2026-08-17T02:15:56.639Z",
                    "status": "pending",
                    "binary": "curl",
                    "kind": "token",
                    "expiresAt": "2026-08-17T02:20:56.639Z",
                ]])
            ) {
                try await rpc.listPendingApprovals()
            }

            try expectEqual(approvals.count, 1)
            try expectEqual(approvals.first?.id, "token_1786932956639_v2wdh9c9wgs")
            try expectEqual(approvals.first?.command, "curl https://example.com")
            try expectEqual(approvals.first?.status, .pending)
            try expectNotNil(approvals.first?.timestamp)
            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "exec.pending")
            await conn.disconnect()
        }

        await test("a timestamp without fractional seconds still decodes") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let approvals = try await withDeferredResponse(
                mock: mock,
                response: try makeOkArrayResponse(id: "rpc-2", payload: [[
                    "id": "exec_1",
                    "command": "npm install",
                    "timestamp": "2026-08-17T02:15:56Z",
                    "status": "pending",
                ]])
            ) {
                try await rpc.listPendingApprovals()
            }

            try expectEqual(approvals.count, 1)
            try expectEqual(approvals.first?.command, "npm install")
            await conn.disconnect()
        }

        await test("a payload the Bar cannot read is reported, not silently empty") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            var threw = false
            do {
                _ = try await withDeferredResponse(
                    mock: mock,
                    response: try makeOkArrayResponse(id: "rpc-2", payload: [[
                        "id": "exec_1",
                        "timestamp": "2026-08-17T02:15:56.639Z",
                        "status": "pending",
                    ]])
                ) {
                    try await rpc.listPendingApprovals()
                }
            } catch {
                threw = true
            }

            try expect(threw, "a malformed approval list must surface an error")
            await conn.disconnect()
        }

        await test("responding sends the approvalId and the decision") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            try await withDeferredResponse(
                mock: mock,
                response: try makeOkResponse(id: "rpc-2", payload: [
                    "ok": true,
                    "approvalId": "token_1",
                    "approved": false,
                    "status": "denied",
                ])
            ) {
                try await rpc.respondToApproval(approvalId: "token_1", approved: false)
            }

            let sent = try await lastSentJSON(mock)
            try expectEqual(sent?["method"] as? String, "exec.respond")
            let params = sent?["params"] as? [String: Any]
            try expectEqual(params?["approvalId"] as? String, "token_1")
            try expectEqual(params?["approved"] as? Bool, false)
            await conn.disconnect()
        }

        // A refused id must not look like a granted approval: the gateway
        // answers ok:false, and the Bar has to keep the row and say so.
        await test("a refused approval id surfaces the gateway error") {
            let (conn, mock, rpc) = try await makeConnectedClient()
            let frame: [String: Any] = [
                "type": "res",
                "id": "rpc-2",
                "ok": false,
                "error": ["code": -32603, "message": "Unknown, expired, or already-resolved approval id: token_x"],
            ]
            var threw = false
            do {
                try await withDeferredResponse(
                    mock: mock,
                    response: try JSONSerialization.data(withJSONObject: frame)
                ) {
                    try await rpc.respondToApproval(approvalId: "token_x", approved: true)
                }
            } catch {
                threw = true
            }

            try expect(threw, "a refused approval must throw")
            await conn.disconnect()
        }
    }
}
