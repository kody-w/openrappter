import Foundation

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

    public func sendChat(message: String, sessionKey: String? = nil) async throws -> ChatAccepted {
        var params: [String: AnyCodable] = [
            "message": AnyCodable(message)
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
            // Convert dict to YAML-like string representation
            let data = try JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted)
            return String(data: data, encoding: .utf8) ?? "{}"
        }
        return ""
    }

    public func setConfig(yaml: String) async throws {
        let params: [String: AnyCodable] = ["config": AnyCodable(yaml)]
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
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        // Try decoding as array directly, or from a wrapper
        if let channels = try? JSONDecoder().decode([Channel].self, from: data) {
            return channels
        }
        return []
    }

    public func getChannel(channelId: String) async throws -> Channel {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.get", params: params)
        return try decodePayload(response)
    }

    public func enableChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId), "enabled": AnyCodable(true)]
        let response = try await connection.sendRequest(method: "channels.update", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func disableChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId), "enabled": AnyCodable(false)]
        let response = try await connection.sendRequest(method: "channels.update", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func deleteChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.delete", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func testChannel(channelId: String) async throws {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.test", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    public func getChannelStatus(channelId: String) async throws -> ChannelStatus {
        let params: [String: AnyCodable] = ["channelId": AnyCodable(channelId)]
        let response = try await connection.sendRequest(method: "channels.status", params: params)
        guard response.ok, let statusStr = response.payload?.value as? String,
              let status = ChannelStatus(rawValue: statusStr) else {
            return .disconnected
        }
        return status
    }

    // MARK: - Cron Methods

    public func listCronJobs() async throws -> [CronJob] {
        let response = try await connection.sendRequest(method: "cron.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list cron jobs") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let jobs = try? JSONDecoder().decode([CronJob].self, from: data) {
            return jobs
        }
        return []
    }

    public func getCronJob(jobId: String) async throws -> CronJob {
        let params: [String: AnyCodable] = ["jobId": AnyCodable(jobId)]
        let response = try await connection.sendRequest(method: "cron.get", params: params)
        return try decodePayload(response)
    }

    public func createCronJob(name: String, schedule: String, command: String) async throws {
        let params: [String: AnyCodable] = [
            "name": AnyCodable(name),
            "schedule": AnyCodable(schedule),
            "command": AnyCodable(command),
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
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to get cron logs") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let logs = try? JSONDecoder().decode([CronExecutionLog].self, from: data) {
            return logs
        }
        return []
    }

    // MARK: - Execution Approval Methods

    public func listPendingApprovals() async throws -> [ExecutionApproval] {
        let response = try await connection.sendRequest(method: "exec.pending")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list approvals") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let approvals = try? JSONDecoder().decode([ExecutionApproval].self, from: data) {
            return approvals
        }
        return []
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
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to get approval history") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let approvals = try? JSONDecoder().decode([ExecutionApproval].self, from: data) {
            return approvals
        }
        return []
    }

    // MARK: - Usage Methods

    public func getUsageStats() async throws -> UsageStats {
        let response = try await connection.sendRequest(method: "usage.stats")
        return try decodePayload(response)
    }

    public func getUsageHistory() async throws -> [UsageEntry] {
        let response = try await connection.sendRequest(method: "usage.history")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to get usage history") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let entries = try? JSONDecoder().decode([UsageEntry].self, from: data) {
            return entries
        }
        return []
    }

    // MARK: - Skills Methods

    public func listSkills() async throws -> [Skill] {
        let response = try await connection.sendRequest(method: "skills.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list skills") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let skills = try? JSONDecoder().decode([Skill].self, from: data) {
            return skills
        }
        return []
    }

    public func installSkill(name: String) async throws {
        let params: [String: AnyCodable] = ["name": AnyCodable(name)]
        let response = try await connection.sendRequest(method: "skills.install", params: params)
        guard response.ok else {
            throw GatewayConnectionError.serverError(code: response.error?.code ?? -1, message: response.error?.message ?? "Unknown error")
        }
    }

    // MARK: - Nodes Methods

    public func listNodes() async throws -> [Node] {
        let response = try await connection.sendRequest(method: "connections.list")
        guard response.ok else { throw RpcClientError.decodingFailed("Failed to list nodes") }
        let data = try JSONEncoder().encode(response.payload ?? AnyCodable([]))
        if let nodes = try? JSONDecoder().decode([Node].self, from: data) {
            return nodes
        }
        return []
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

    var errorDescription: String? {
        switch self {
        case .decodingFailed(let msg): return "Decoding failed: \(msg)"
        }
    }
}
