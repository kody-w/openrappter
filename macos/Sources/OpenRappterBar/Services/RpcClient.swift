import Foundation

private struct GatewayChannelDTO: Decodable {
    let id: String?
    let type: String?
    let name: String?
    let connected: Bool?
    let configured: Bool?
    let running: Bool?
    let enabled: Bool?
    let actionable: Bool?
    let configurable: Bool?
    let status: String?
    let config: [String: AnyCodable]?

    private enum CodingKeys: String, CodingKey {
        case id
        case channelId
        case type
        case channelType
        case name
        case connected
        case configured
        case running
        case enabled
        case actionable
        case configurable
        case status
        case config
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? container.decodeIfPresent(String.self, forKey: .channelId)
        type = try container.decodeIfPresent(String.self, forKey: .type)
            ?? container.decodeIfPresent(String.self, forKey: .channelType)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        connected = Self.decodeBool(from: container, forKey: .connected)
        configured = Self.decodeBool(from: container, forKey: .configured)
        running = Self.decodeBool(from: container, forKey: .running)
        enabled = Self.decodeBool(from: container, forKey: .enabled)
        actionable = Self.decodeBool(from: container, forKey: .actionable)
        configurable = Self.decodeBool(from: container, forKey: .configurable)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        config = try container.decodeIfPresent([String: AnyCodable].self, forKey: .config)
    }

    private static func decodeBool(
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> Bool? {
        if let value = try? container.decodeIfPresent(Bool.self, forKey: key) {
            return value
        }
        if let value = try? container.decodeIfPresent(Int.self, forKey: key) {
            return value != 0
        }
        if let value = try? container.decodeIfPresent(String.self, forKey: key) {
            switch value.lowercased() {
            case "true", "yes", "1": return true
            case "false", "no", "0": return false
            default: return nil
            }
        }
        return nil
    }
}

// MARK: - RPC Client

/// Typed RPC method wrapper around GatewayConnection.
/// No longer needs actor isolation — the connection actor handles thread safety.
public struct RpcClient: RpcClientProtocol, Sendable {
    private let connection: GatewayConnection

    public init(connection: GatewayConnection) {
        self.connection = connection
    }

    // MARK: - Typed Methods

    public func getStatus() async throws -> GatewayStatusResponse {
        let response = try await connection.sendRequest(method: "status")
        return try decodePayload(response)
    }

    public func getHealth() async throws -> HealthResponse {
        let response = try await connection.sendRequest(method: "health")
        return try decodePayload(response)
    }

    public func ping() async throws -> PingResponse {
        let response = try await connection.sendRequest(method: "ping")
        return try decodePayload(response)
    }

    public func beginGatewayAuthentication() async throws -> GatewayAuthLoginResponse {
        let response = try await connection.sendRequest(method: "auth.login")
        return try decodePayload(response)
    }

    public func pollGatewayAuthentication(
        deviceCode: String
    ) async throws -> GatewayAuthPollResponse {
        let response = try await connection.sendRequest(
            method: "auth.poll",
            params: ["deviceCode": AnyCodable(deviceCode)]
        )
        return try decodePayload(response)
    }

    public func cancelGatewayAuthentication(
        deviceCode: String
    ) async throws -> GatewayAuthCancelResponse {
        let response = try await connection.sendRequest(
            method: "auth.cancel",
            params: ["deviceCode": AnyCodable(deviceCode)]
        )
        return try decodePayload(response)
    }

    public func activeGatewayAuthProfile() async throws -> GatewayAuthProfile? {
        let response = try await connection.sendRequest(method: "auth.active")
        guard response.ok else {
            let detail = response.error ?? RpcErrorDetail(code: -1, message: "Unknown error")
            throw GatewayConnectionError.serverError(
                code: detail.code,
                message: detail.message
            )
        }
        guard response.payload != nil else { return nil }
        return try decodePayload(response)
    }

    public func removeGatewayAuthProfile(id: String) async throws {
        let response = try await connection.sendRequest(
            method: "auth.remove",
            params: ["id": AnyCodable(id)]
        )
        let result: [String: Bool] = try decodePayload(response)
        guard result["ok"] == true else {
            throw RpcClientError.decodingFailed("Gateway refused to remove auth profile")
        }
    }

    public func switchGatewayAuthProfile(id: String) async throws {
        let response = try await connection.sendRequest(
            method: "auth.switch",
            params: ["id": AnyCodable(id)]
        )
        let result: [String: Bool] = try decodePayload(response)
        guard result["ok"] == true else {
            throw RpcClientError.decodingFailed("Gateway refused to switch auth profile")
        }
    }

    public func sendChat(
        message: String,
        sessionKey: String? = nil,
        target: ChatTarget = .openrappter
    ) async throws -> ChatAccepted {
        var params: [String: AnyCodable] = [
            "message": AnyCodable(message),
            // Which brain answers. Always sent, including the default, so a
            // gateway that ever changes its own default cannot silently move
            // the conversation to the other brain.
            "target": AnyCodable(target.rawValue)
        ]
        if let sessionKey {
            params["sessionKey"] = AnyCodable(sessionKey)
        }
        let response = try await connection.sendRequest(method: "chat.send", params: params)
        return try decodePayload(response)
    }

    public func listMethods() async throws -> [String] {
        let response = try await connection.sendRequest(method: "methods")
        guard response.ok, let arr = response.payload?.value as? [Any] else {
            throw RpcClientError.decodingFailed("Expected string array")
        }
        return arr.compactMap { $0 as? String }
    }

    // MARK: - Session Methods

    public func listSessions() async throws -> [[String: Any]] {
        let response = try await connection.sendRequest(method: "chat.list")
        guard response.ok else {
            throw RpcClientError.decodingFailed("Failed to list sessions")
        }
        if let arr = response.payload?.value as? [[String: Any]] {
            return arr
        }
        if let dict = response.payload?.value as? [String: Any],
           let sessions = dict["sessions"] as? [[String: Any]] {
            return sessions
        }
        return []
    }

    public func getSessionMessages(sessionKey: String) async throws -> [[String: Any]] {
        let params: [String: AnyCodable] = ["sessionKey": AnyCodable(sessionKey)]
        let response = try await connection.sendRequest(method: "chat.messages", params: params)
        guard response.ok else {
            throw RpcClientError.decodingFailed("Failed to get messages")
        }
        if let arr = response.payload?.value as? [[String: Any]] {
            return arr
        }
        if let dict = response.payload?.value as? [String: Any],
           let messages = dict["messages"] as? [[String: Any]] {
            return messages
        }
        return []
    }

    public func deleteSession(sessionKey: String) async throws {
        let params: [String: AnyCodable] = ["sessionKey": AnyCodable(sessionKey)]
        let response = try await connection.sendRequest(method: "chat.delete", params: params)
        guard response.ok else {
            let msg = response.error?.message ?? "Unknown error"
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: msg)
        }
    }

    public func resetSession(sessionKey: String) async throws {
        let params: [String: AnyCodable] = ["sessionKey": AnyCodable(sessionKey)]
        let response = try await connection.sendRequest(method: "sessions.reset", params: params)
        guard response.ok else {
            let msg = response.error?.message ?? "Unknown error"
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: msg)
        }
    }

    public func abortChat(sessionKey: String) async throws {
        let params: [String: AnyCodable] = ["sessionKey": AnyCodable(sessionKey)]
        let response = try await connection.sendRequest(method: "chat.abort", params: params)
        guard response.ok else {
            let msg = response.error?.message ?? "Unknown error"
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: msg)
        }
    }

    // MARK: - Config Methods

    public func getConfig() async throws -> String {
        let response = try await connection.sendRequest(method: "config.get")
        guard response.ok else {
            throw RpcClientError.decodingFailed("Failed to get config")
        }
        if let yaml = response.payload?.value as? String {
            return yaml
        }
        if let dict = response.payload?.value as? [String: Any] {
            // The gateway answers with a snapshot, not a bare string. Read the
            // config out of it; serialising the whole envelope showed the user
            // `{"content": "..."}` instead of their YAML.
            if let raw = dict["raw"] as? String {
                return raw
            }
            if let content = dict["content"] as? String {
                return content
            }
            let data = try JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted)
            return String(data: data, encoding: .utf8) ?? "{}"
        }
        return ""
    }

    public func setConfig(yaml: String) async throws {
        // `raw` is the canonical field name; the gateway still accepts the
        // older `config` and `content` spellings.
        let params: [String: AnyCodable] = ["raw": AnyCodable(yaml)]
        let response = try await connection.sendRequest(method: "config.set", params: params)
        guard response.ok else {
            let msg = response.error?.message ?? "Unknown error"
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: msg)
        }
    }

    public func patchConfig(patch: [String: Any]) async throws {
        let params: [String: AnyCodable] = ["patch": AnyCodable(patch)]
        let response = try await connection.sendRequest(method: "config.patch", params: params)
        guard response.ok else {
            let msg = response.error?.message ?? "Unknown error"
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: msg)
        }
    }

    // MARK: - Channel Methods

    public func listChannels() async throws -> [Channel] {
        let response = try await connection.sendRequest(method: "channels.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list channels") }
        guard let payload = response.payload else {
            throw RpcClientError.decodingFailed("Missing channels.list payload")
        }

        let rows = try Self.channelRows(from: payload)
        return rows.enumerated().compactMap { index, row in
            do {
                let data = try JSONEncoder().encode(AnyCodable(row))
                let dto = try JSONDecoder().decode(GatewayChannelDTO.self, from: data)
                return try Self.mapChannel(dto)
            } catch {
                Log.rpc.warning(
                    "Skipping invalid channels.list entry \(index): \(error.localizedDescription)"
                )
                return nil
            }
        }
    }

    public func getChannel(channelId: String) async throws -> Channel {
        // The gateway has no `channels.get` RPC method — derive the single
        // channel from the canonical `channels.list` response instead of
        // calling a name that was never registered server-side.
        let channels = try await listChannels()
        guard let channel = channels.first(where: {
            $0.id == channelId || $0.type.rawValue == Self.normalizedChannelType(channelId)
        }) else {
            throw RpcClientError.decodingFailed("Channel not found: \(channelId)")
        }
        return channel
    }

    public func enableChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["type": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.connect", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func disableChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["type": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.disconnect", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func testChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["type": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.probe", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }

        guard let payload = response.payload?.value as? [String: Any] else {
            throw RpcClientError.decodingFailed("Expected channels.probe result")
        }
        let probe = (payload["probe"] as? [String: Any]) ?? payload
        let ok = (probe["ok"] as? Bool) ?? (probe["success"] as? Bool)
        guard let ok else {
            throw RpcClientError.decodingFailed("Missing channels.probe ok flag")
        }
        guard ok else {
            let message = (probe["error"] as? String)
                ?? (probe["message"] as? String)
                ?? "Channel probe failed"
            throw RpcClientError.channelProbeFailed(message)
        }
    }

    public func getChannelStatus(channelId: String) async throws -> ChannelStatus {
        // The gateway has no `channels.status` RPC method — derive status
        // from the canonical `channels.list` response's `connected` flag.
        let channels = try await listChannels()
        return channels.first(where: {
            $0.id == channelId || $0.type.rawValue == Self.normalizedChannelType(channelId)
        })?.status ?? .disconnected
    }

    // MARK: - Cron Methods

    public func listCronJobs() async throws -> [CronJob] {
        let response = try await connection.sendRequest(method: "cron.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list cron jobs") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let str = try? container.decode(String.self) {
                let fmt = ISO8601DateFormatter()
                fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return fmt.date(from: str) ?? Date()
            }
            if container.decodeNil() { return Date.distantPast }
            return Date()
        }
        if let jobs = try? decoder.decode([CronJob].self, from: data) {
            return jobs
        }
        // Fallback: manually parse each job, skipping fields that fail
        if let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            return array.compactMap { dict in
                guard let id = dict["id"] as? String,
                      let name = dict["name"] as? String,
                      let schedule = dict["schedule"] as? String else { return nil }
                return CronJob(
                    id: id,
                    name: name,
                    schedule: schedule,
                    command: (dict["command"] as? String) ?? (dict["message"] as? String) ?? "",
                    enabled: (dict["enabled"] as? Bool) ?? true
                )
            }
        }
        return []
    }

    public func getCronJob(jobId: String) async throws -> CronJob {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.get", params: params)
        return try decodePayload(response)
    }

    public func createCronJob(name: String, schedule: String, command: String) async throws {
        // `message` is the gateway's field name — the cron store, the scheduler
        // and the CLI all use it. This client sent `command`, so every job it
        // created ran on schedule with an empty prompt. The gateway still
        // accepts `command` for older builds; new builds send the real name.
        let params: [String: AnyCodable] = [
            "name": AnyCodable(name),
            "schedule": AnyCodable(schedule),
            "message": AnyCodable(command),
        ]
        let response = try await connection.sendRequest(method: "cron.create", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func updateCronJob(jobId: String, updates: [String: Any]) async throws {
        var params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        for (key, value) in updates {
            params[key] = AnyCodable(value)
        }
        let response = try await connection.sendRequest(method: "cron.update", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func deleteCronJob(jobId: String) async throws {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.delete", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func pauseCronJob(jobId: String) async throws {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.pause", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func resumeCronJob(jobId: String) async throws {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.resume", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func triggerCronJob(jobId: String) async throws {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.trigger", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func getCronLogs(jobId: String? = nil) async throws -> [CronExecutionLog] {
        var params: [String: AnyCodable] = [:]
        if let jobId { params["jobId"] = AnyCodable(jobId) }
        let response = try await connection.sendRequest(method: "cron.logs", params: params.isEmpty ? nil : params)
        guard response.ok else { return [] }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable(["runs": []]))

        // Parse the {runs: [...]} wrapper
        guard let wrapper = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runs = wrapper["runs"] as? [[String: Any]] else { return [] }

        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtBasic = ISO8601DateFormatter()

        return runs.compactMap { dict in
            guard let id = dict["id"] as? String,
                  let jobId = dict["jobId"] as? String else { return nil }
            let startedStr = dict["startedAt"] as? String ?? ""
            let completedStr = dict["completedAt"] as? String
            let timestamp = fmt.date(from: startedStr) ?? fmtBasic.date(from: startedStr) ?? Date()
            let statusStr = dict["status"] as? String ?? "success"
            let result: CronResult = statusStr == "error" ? .failure : (statusStr == "running" ? .skipped : .success)
            let output = dict["result"] as? String ?? dict["error"] as? String
            var duration: TimeInterval? = nil
            if let completed = completedStr, let endDate = fmt.date(from: completed) ?? fmtBasic.date(from: completed) {
                duration = endDate.timeIntervalSince(timestamp)
            }
            return CronExecutionLog(id: id, jobId: jobId, timestamp: timestamp, result: result, output: output, duration: duration)
        }
    }

    // MARK: - Execution Approval Methods

    /// The gateway timestamps approvals as ISO-8601 strings (`toISOString()`,
    /// so always with milliseconds), while `JSONDecoder`'s default date
    /// strategy expects a `Double`. Decoding `ExecutionApproval` with a stock
    /// decoder therefore always failed — and the old `try?` turned that into an
    /// empty array, i.e. an approval screen that silently shows nothing while
    /// commands sit blocked. Accept both spellings, with and without fractional
    /// seconds.
    private static func approvalDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let basic = ISO8601DateFormatter()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                if let date = withFraction.date(from: text) ?? basic.date(from: text) {
                    return date
                }
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Unrecognised approval timestamp: \(text)"
                )
            }
            // Numeric timestamps stay readable for any client that sends them.
            let seconds = try container.decode(Double.self)
            return Date(timeIntervalSince1970: seconds > 3_000_000_000 ? seconds / 1000 : seconds)
        }
        return decoder
    }

    public func listPendingApprovals() async throws -> [ExecutionApproval] {
        let response = try await connection.sendRequest(method: "exec.pending")
        guard response.ok else {
            throw GatewayConnectionError.serverError(
                code: response.error?.code ?? -1,
                message: response.error?.message ?? "Failed to list approvals"
            )
        }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        // Throw rather than return []: an approval the user cannot see is an
        // approval they cannot deny, so a decode failure must be visible.
        do {
            return try Self.approvalDecoder().decode([ExecutionApproval].self, from: data)
        } catch {
            throw RpcClientError.decodingFailed("Pending approvals: \(error)")
        }
    }

    public func respondToApproval(approvalId: String, approved: Bool) async throws {
        let params: [String: AnyCodable] = [
            "approvalId": AnyCodable(approvalId),
            "approved": AnyCodable(approved),
        ]
        let response = try await connection.sendRequest(method: "exec.respond", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func getApprovalHistory() async throws -> [ExecutionApproval] {
        let response = try await connection.sendRequest(method: "exec.history")
        guard response.ok else {
            throw GatewayConnectionError.serverError(
                code: response.error?.code ?? -1,
                message: response.error?.message ?? "Failed to get approval history"
            )
        }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        do {
            return try Self.approvalDecoder().decode([ExecutionApproval].self, from: data)
        } catch {
            throw RpcClientError.decodingFailed("Approval history: \(error)")
        }
    }

    // MARK: - Usage Methods

    public func getUsageStats() async throws -> UsageStats {
        let response = try await connection.sendRequest(method: "usage.stats")
        return try decodePayload(response)
    }

    /// Recent per-request usage entries.
    ///
    /// The gateway timestamps these as ISO-8601 strings, like every other
    /// timestamp on this wire. A bare `JSONDecoder()` uses
    /// `.deferredToDate`, which demands a `Double` and fails on a string —
    /// and because the failure was swallowed by `try?`, every entry the
    /// gateway sent was silently discarded and this returned `[]`. Same
    /// custom strategy as `listCronJobs()`, for the same reason.
    public func getUsageHistory() async throws -> [UsageEntry] {
        let response = try await connection.sendRequest(method: "usage.history")
        guard response.ok else {
            let detail = response.error ?? RpcErrorDetail(code: -1, message: "Failed to get usage history")
            throw GatewayConnectionError.serverError(code: detail.code, message: detail.message)
        }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            guard let str = try? container.decode(String.self) else {
                throw RpcClientError.decodingFailed("usage.history timestamp was not a string")
            }
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: str) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            guard let date = plain.date(from: str) else {
                throw RpcClientError.decodingFailed("usage.history timestamp was not ISO-8601: \(str)")
            }
            return date
        }
        return try decoder.decode([UsageEntry].self, from: data)
    }

    // MARK: - Skills Methods

    /// List skills the gateway knows about — bundled and installed.
    ///
    /// A decode failure is surfaced, not swallowed. It used to return `[]`,
    /// which the Skills pane renders as "No skills installed" — so a payload
    /// the Bar could not read was indistinguishable from a machine with no
    /// skills. The gateway ships 52 bundled skills, and the pane showed none
    /// of them for exactly that reason.
    public func listSkills() async throws -> [Skill] {
        let response = try await connection.sendRequest(method: "skills.list")
        guard response.ok else {
            throw GatewayConnectionError.serverError(
                code: response.error?.code ?? -1,
                message: response.error?.message ?? "Failed to list skills"
            )
        }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        do {
            return try JSONDecoder().decode([Skill].self, from: data)
        } catch {
            throw RpcClientError.decodingFailed("skills.list returned a payload this build cannot read: \(error)")
        }
    }

    public func installSkill(name: String) async throws {
        let params: [String: AnyCodable] = ["name": AnyCodable(name)]
        let response = try await connection.sendRequest(method: "skills.install", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    // MARK: - Nodes Methods

    /// List the connections attached to the gateway.
    ///
    /// A decode failure is surfaced rather than becoming an empty list. The
    /// empty list is not harmless here: `disconnectNode` takes its
    /// `connectionId` from a row of this list, so a payload the Bar could not
    /// read left the Nodes pane empty AND made disconnect unreachable.
    public func listNodes() async throws -> [Node] {
        let response = try await connection.sendRequest(method: "connections.list")
        guard response.ok else {
            throw GatewayConnectionError.serverError(
                code: response.error?.code ?? -1,
                message: response.error?.message ?? "Failed to list nodes"
            )
        }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        do {
            return try Self.gatewayDecoder().decode([Node].self, from: data)
        } catch {
            throw RpcClientError.decodingFailed("connections.list returned a payload this build cannot read: \(error)")
        }
    }

    /// A decoder for gateway payloads whose dates are ISO-8601 strings.
    ///
    /// `JSONDecoder`'s default `.deferredToDate` expects a number of seconds
    /// since 2001, so an ISO-8601 string fails outright, and `.iso8601`
    /// rejects the fractional seconds that JavaScript's `toISOString()`
    /// always emits. Either failure fails the whole array.
    static func gatewayDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            guard let str = try? container.decode(String.self) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "expected an ISO-8601 date string"
                )
            }
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: str) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            if let date = plain.date(from: str) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "not an ISO-8601 date: \(str)"
            )
        }
        return decoder
    }

    public func disconnectNode(connectionId: String) async throws {
        let params: [String: AnyCodable] = ["connectionId": AnyCodable(connectionId)]
        let response = try await connection.sendRequest(method: "connections.disconnect", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func pairNode(host: String, port: Int) async throws {
        let params: [String: AnyCodable] = [
            "host": AnyCodable(host),
            "port": AnyCodable(port),
        ]
        let response = try await connection.sendRequest(method: "connections.pair", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func getNodeInfo(connectionId: String) async throws -> Node {
        let params: [String: AnyCodable] = ["connectionId": AnyCodable(connectionId)]
        let response = try await connection.sendRequest(method: "connections.info", params: params)
        return try decodePayload(response)
    }

    // MARK: - Logs Methods

    public func getLogs(limit: Int = 100) async throws -> [[String: Any]] {
        let params: [String: AnyCodable] = ["limit": AnyCodable(limit)]
        let response = try await connection.sendRequest(method: "logs.get", params: params)
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to get logs") }
        if let arr = response.payload?.value as? [[String: Any]] {
            return arr
        }
        return []
    }

    // MARK: - Models Methods

    public func listModels() async throws -> [[String: Any]] {
        let response = try await connection.sendRequest(method: "models.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list models") }
        if let arr = response.payload?.value as? [[String: Any]] {
            return arr
        }
        return []
    }

    // MARK: - Agents Methods

    public func listAgents() async throws -> [[String: Any]] {
        let response = try await connection.sendRequest(method: "agents.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list agents") }
        if let arr = response.payload?.value as? [[String: Any]] {
            return arr
        }
        return []
    }

    public func getAgentInfo(name: String) async throws -> [String: Any] {
        let params: [String: AnyCodable] = ["name": AnyCodable(name)]
        let response = try await connection.sendRequest(method: "agents.info", params: params)
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to get agent info") }
        if let dict = response.payload?.value as? [String: Any] {
            return dict
        }
        return [:]
    }

    public func executeAgent(name: String, params agentParams: [String: Any]) async throws -> [String: Any] {
        var rpcParams: [String: AnyCodable] = ["name": AnyCodable(name)]
        rpcParams["params"] = AnyCodable(agentParams)
        let response = try await connection.sendRequest(method: "agents.execute", params: rpcParams)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
        if let dict = response.payload?.value as? [String: Any] {
            return dict
        }
        return [:]
    }

    // MARK: - Helpers

    private static func mapChannel(_ dto: GatewayChannelDTO) throws -> Channel {
        let rawID = nonBlank(dto.id)
        guard let rawType = nonBlank(dto.type) ?? rawID else {
            throw RpcClientError.decodingFailed("Channel entry is missing id/type")
        }
        let normalizedType = normalizedChannelType(rawType)
        guard let type = ChannelType(rawValue: normalizedType) else {
            throw RpcClientError.decodingFailed("Unsupported channel type: \(rawType)")
        }

        let id = rawID ?? normalizedType
        let explicitStatus = dto.status
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .flatMap(ChannelStatus.init(rawValue:))
        let connected = dto.connected ?? (explicitStatus == .connected)
        let running = dto.running ?? dto.enabled ?? connected
        let status: ChannelStatus
        if connected {
            status = .connected
        } else if explicitStatus == .error {
            status = .error
        } else if running || explicitStatus == .connecting {
            status = .connecting
        } else {
            status = .disconnected
        }

        // `running` is the canonical toggle state. Older gateways exposed
        // `enabled`, and very old wrappers only exposed `configured`.
        let enabled = dto.running ?? dto.enabled ?? dto.connected ?? dto.configured ?? false
        let name = dto.name ?? id
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
        let isSyntheticStatusOnly = Self.syntheticStatusOnlyTypes.contains(type)
            && dto.configured == false
        let actionable = dto.actionable ?? !isSyntheticStatusOnly
        let configurable = dto.configurable ?? !isSyntheticStatusOnly

        return Channel(
            id: id,
            name: name,
            type: type,
            enabled: enabled,
            config: dto.config,
            status: status,
            actionable: actionable,
            configurable: configurable
        )
    }

    private static let syntheticStatusOnlyTypes: Set<ChannelType> = [
        .signal,
        .matrix,
        .teams,
        .googleChat,
    ]

    private static func channelRows(from payload: AnyCodable) throws -> [Any] {
        if let rows = payload.value as? [Any] {
            return rows
        }
        if let envelope = payload.value as? [String: Any] {
            if let rows = envelope["channels"] as? [Any] {
                return rows
            }
            if let rows = envelope["items"] as? [Any] {
                return rows
            }
        }
        throw RpcClientError.decodingFailed("Expected channels.list array or channels wrapper")
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func normalizedChannelType(_ rawValue: String) -> String {
        let normalized = rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")

        switch normalized {
        case "googlechat", "google_chat": return ChannelType.googleChat.rawValue
        case "i_message", "imessage": return ChannelType.imessage.rawValue
        case "whats_app", "whatsapp": return ChannelType.whatsapp.rawValue
        default: return normalized
        }
    }

    private func decodePayload<T: Decodable>(_ response: RpcResponseFrame) throws -> T {
        guard response.ok else {
            let detail = response.error ?? RpcErrorDetail(code: -1, message: "Unknown error")
            throw GatewayConnectionError.serverError(code: detail.code, message: detail.message)
        }

        guard let payload = response.payload else {
            throw RpcClientError.decodingFailed("No payload in response")
        }

        // Re-encode the AnyCodable payload to JSON, then decode to the target type
        let data = try JSONEncoder().encode(payload)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

enum RpcClientError: Error, LocalizedError {
    case decodingFailed(String)
    case channelProbeFailed(String)

    var errorDescription: String? {
        switch self {
        case .decodingFailed(let msg): return "Decoding failed: \(msg)"
        case .channelProbeFailed(let msg): return "Channel probe failed: \(msg)"
        }
    }
}
