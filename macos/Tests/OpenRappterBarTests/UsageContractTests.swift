import Foundation
@testable import OpenRappterBarLib

// MARK: - Usage Contract Tests
//
// The Bar's usage screen calls `usage.stats` and `usage.history`. Two
// independent things had to be true for it to show a number, and neither was:
//
//  1. The live `GatewayServer` had to register those names. It registered
//     neither, so both calls came back "Method not found".
//  2. `RpcClient.getUsageHistory()` had to decode what the gateway sends. It
//     used a bare `JSONDecoder()`, whose `.deferredToDate` strategy demands a
//     `Double` and throws on the ISO-8601 string every other timestamp on this
//     wire uses — and the throw was swallowed by `try?`, so a fully populated
//     response was silently rendered as an empty list.
//
// These tests decode `contracts/usage-v1.json`, captured from a live
// `GatewayServer` over this exact WebSocket wire. The TypeScript suite asserts
// the running gateway still reproduces that file, so the two runtimes are
// pinned to one shape from both ends.

private func usageVector() throws -> [String: Any] {
    // Tests/OpenRappterBarTests/UsageContractTests.swift -> repo root
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // OpenRappterBarTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // macos
        .deletingLastPathComponent()   // repo root
    let url = root.appendingPathComponent("contracts/usage-v1.json")
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "usage-vector", code: 1)
    }
    return object
}

private func makeUsageResponse(id: String, payload: Any) throws -> Data {
    let frame: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
    return try JSONSerialization.data(withJSONObject: frame)
}

private func makeUsageError(id: String, code: Int, message: String) throws -> Data {
    let frame: [String: Any] = [
        "type": "res",
        "id": id,
        "ok": false,
        "error": ["code": code, "message": message] as [String: Any],
    ]
    return try JSONSerialization.data(withJSONObject: frame)
}

private func connectedUsageClient() async throws -> (GatewayConnection, MockWebSocket, RpcClient) {
    let mock = MockWebSocket()
    let conn = GatewayConnection(transportFactory: { _ in mock })
    mock.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
    try await conn.connect()
    return (conn, mock, RpcClient(connection: conn))
}

private func deferred<T: Sendable>(
    mock: MockWebSocket,
    response: Data,
    call: @Sendable @escaping () async throws -> T
) async throws -> T {
    async let result = call()
    _ = try await mock.waitForSentCount(2)
    mock.enqueueReceive(response)
    return try await result
}

func runUsageContractTests() async {
    await suite("Usage RPC Contract") {
        await test("usage stats resolve to the gateway's usage.stats method") {
            let vector = try usageVector()
            let (conn, mock, rpc) = try await connectedUsageClient()
            let stats = try await deferred(
                mock: mock,
                response: try makeUsageResponse(id: "rpc-2", payload: vector["usage.stats"] as Any)
            ) {
                try await rpc.getUsageStats()
            }

            let sent = try await mock.waitForSentCount(2)
            let json = try JSONSerialization.jsonObject(with: sent.last!) as? [String: Any]
            try expectEqual(json?["method"] as? String, "usage.stats")

            // Straight off the live gateway's numbers, not a placeholder.
            try expectEqual(stats.totalTokens, 1632)
            try expectEqual(stats.promptTokens, 1280)
            try expectEqual(stats.completionTokens, 352)
            try expectEqual(stats.requestCount, 2)
            await conn.disconnect()
        }

        await test("usage history decodes the gateway's ISO-8601 timestamps") {
            let vector = try usageVector()
            let (conn, mock, rpc) = try await connectedUsageClient()
            let entries = try await deferred(
                mock: mock,
                response: try makeUsageResponse(id: "rpc-2", payload: vector["usage.history"] as Any)
            ) {
                try await rpc.getUsageHistory()
            }

            let sent = try await mock.waitForSentCount(2)
            let json = try JSONSerialization.jsonObject(with: sent.last!) as? [String: Any]
            try expectEqual(json?["method"] as? String, "usage.history")

            // The defect this guards: a bare JSONDecoder threw on the string
            // timestamp and `try?` turned a populated response into `[]`.
            try expectEqual(entries.count, 2)
            try expectEqual(entries.first?.model, "gpt-4o-mini")
            try expectEqual(entries.first?.tokens, 92)
            try expectEqual(entries.last?.tokens, 1540)

            let expected = ISO8601DateFormatter()
            expected.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let rows = vector["usage.history"] as? [[String: Any]]
            let firstStamp = expected.date(from: rows?.first?["timestamp"] as? String ?? "")
            try expectNotNil(firstStamp, "the vector timestamp must itself be ISO-8601")
            try expectEqual(entries.first?.timestamp, firstStamp)
            await conn.disconnect()
        }

        await test("a gateway error surfaces instead of an empty usage list") {
            // Before: `guard response.ok else { throw decodingFailed(...) }`
            // discarded the gateway's actual reason ("the Flight Recorder is
            // disabled"), and the decode path below turned everything else
            // into a silent `[]`. The screen has to be able to say why.
            let (conn, mock, rpc) = try await connectedUsageClient()
            var message: String?
            do {
                _ = try await deferred(
                    mock: mock,
                    response: try makeUsageError(
                        id: "rpc-2",
                        code: -32603,
                        message: "Usage is not being recorded: the Flight Recorder is disabled"
                    )
                ) {
                    try await rpc.getUsageHistory()
                }
            } catch {
                message = "\(error)"
            }
            try expectNotNil(message, "getUsageHistory must throw when the gateway says no")
            try expect(
                message?.contains("Flight Recorder is disabled") == true,
                "the gateway's reason must reach the user, got: \(message ?? "nil")"
            )
            await conn.disconnect()
        }

        test("cost is reported as unmeasured rather than as $0.0000") {
            // No price table exists in this runtime and the default backend is
            // a subscription with no per-token price. `$0.0000` would be a
            // number nobody measured, shown next to real token counts.
            let unpriced = UsageStats(totalTokens: 1632, totalCost: 0, costAvailable: false)
            try expectEqual(unpriced.formattedCost, "n/a")

            let priced = UsageStats(totalTokens: 10, totalCost: 0.0042, costAvailable: true)
            try expectEqual(priced.formattedCost, "$0.0042")

            // An older gateway that sends no `costAvailable` is unknown, not free.
            let legacy = UsageStats(totalTokens: 10, totalCost: 0)
            try expectEqual(legacy.formattedCost, "n/a")
        }

        test("the live gateway payload decodes into UsageStats end to end") {
            let vector = try usageVector()
            let payload = vector["usage.stats"] as? [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload as Any)
            let stats = try JSONDecoder().decode(UsageStats.self, from: data)
            try expectEqual(stats.costAvailable, false)
            try expectEqual(stats.formattedTokens, "1.6K")
            try expectEqual(stats.period, "all recorded activity")
        }

        test("nothing in the usage vector carries a session id or prompt text") {
            // The Flight Recorder omits prompt bodies and HMACs session ids;
            // the usage endpoint narrows further and forwards neither. Only
            // the two RPC payloads are checked — the file's own prose is not
            // part of the wire.
            let vector = try usageVector()
            for key in ["usage.stats", "usage.history"] {
                let data = try JSONSerialization.data(
                    withJSONObject: vector[key] as Any
                )
                let wire = String(data: data, encoding: .utf8) ?? ""
                for forbidden in ["sessionId", "sessionKey", "session:", "messages", "payload"] {
                    try expect(
                        !wire.contains(forbidden),
                        "\(key) must not carry \(forbidden)"
                    )
                }
            }
        }
    }
}
