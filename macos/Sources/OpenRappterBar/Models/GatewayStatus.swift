import Foundation

// MARK: - Gateway Status (mirrors TypeScript GatewayStatus)

public struct GatewayStatusResponse: Codable, Sendable {
    public let running: Bool
    public let port: Int
    public let connections: Int
    public let uptime: Int
    public let version: String
    public let startedAt: String
}

// MARK: - Health Response (mirrors TypeScript HealthResponse)

public struct HealthResponse: Codable, Sendable {
    public let status: String  // "ok" | "degraded" | "error"
    public let version: String
    public let uptime: Int
    public let timestamp: String
    public let checks: HealthChecks
}

public struct HealthChecks: Codable, Sendable {
    public let gateway: Bool
    public let storage: Bool?
    public let channels: Bool?
    public let agents: Bool?
}

// MARK: - Chat Accepted (response to chat.send)

public struct ChatAccepted: Codable, Sendable {
    public let runId: String
    public let sessionKey: String
    public let status: String  // "accepted"
    public let acceptedAt: Int
}

// MARK: - Chat Event Payload (from "chat" events)

public struct ChatEventPayload: Sendable {
    public let runId: String
    public let sessionKey: String
    public let state: ChatEventState
    public let messageText: String?
    public let errorMessage: String?
}

public enum ChatEventState: String, Sendable {
    case delta
    case final_ = "final"
    case error
}

public extension ChatEventPayload {
    /// Parse from the AnyCodable payload of an event frame.
    static func parse(from value: Any) -> ChatEventPayload? {
        guard let dict = value as? [String: Any],
              let runId = dict["runId"] as? String,
              let sessionKey = dict["sessionKey"] as? String,
              let stateStr = dict["state"] as? String else {
            return nil
        }

        let state: ChatEventState
        switch stateStr {
        case "delta": state = .delta
        case "final": state = .final_
        case "error": state = .error
        default: return nil
        }

        // Extract text from message.content[0].text
        var messageText: String?
        if let message = dict["message"] as? [String: Any],
           let content = message["content"] as? [[String: Any]],
           let first = content.first,
           let text = first["text"] as? String {
            messageText = text
        }

        let errorMessage = dict["errorMessage"] as? String

        return ChatEventPayload(
            runId: runId,
            sessionKey: sessionKey,
            state: state,
            messageText: messageText,
            errorMessage: errorMessage
        )
    }
}

// MARK: - Connect Handshake Response

public struct HelloOkPayload: Codable, Sendable {
    public let type: String  // "hello-ok"
    public let `protocol`: Int
    public let server: ServerInfo
}

public struct ServerInfo: Codable, Sendable {
    public let version: String
    public let host: String
    public let connId: String
}

// MARK: - Ping Response

public struct PingResponse: Codable, Sendable {
    public let pong: Int
}
