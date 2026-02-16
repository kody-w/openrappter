import Foundation

// MARK: - RPC Client

/// Actor wrapping GatewayConnection with typed RPC method calls.
public actor RpcClient {
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
