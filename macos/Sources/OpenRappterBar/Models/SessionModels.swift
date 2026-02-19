import Foundation

// MARK: - Session

public struct Session: Codable, Identifiable, Sendable {
    public let id: String
    public var sessionKey: String
    public var title: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var messageCount: Int

    public init(
        id: String = UUID().uuidString,
        sessionKey: String,
        title: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        messageCount: Int = 0
    ) {
        self.id = id
        self.sessionKey = sessionKey
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
    }

    /// Display title — uses the session title or a truncated session key.
    public var displayTitle: String {
        title ?? "Session \(String(sessionKey.prefix(8)))"
    }
}

// MARK: - Chat Message

public struct ChatMessage: Codable, Identifiable, Sendable {
    public let id: String
    public let role: MessageRole
    public let content: String
    public let timestamp: Date
    public let sessionKey: String

    public init(
        id: String = UUID().uuidString,
        role: MessageRole,
        content: String,
        timestamp: Date = Date(),
        sessionKey: String
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.sessionKey = sessionKey
    }
}

public enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
    case system
    case error
}

// MARK: - Session Preview

public struct SessionPreview: Codable, Sendable {
    public let sessionKey: String
    public let messageCount: Int
    public let lastMessage: String?
    public let lastActivity: Date?

    public init(
        sessionKey: String,
        messageCount: Int = 0,
        lastMessage: String? = nil,
        lastActivity: Date? = nil
    ) {
        self.sessionKey = sessionKey
        self.messageCount = messageCount
        self.lastMessage = lastMessage
        self.lastActivity = lastActivity
    }
}

// MARK: - Session Cache (for local persistence)

struct SessionCache: Codable {
    var sessions: [Session]
    var messages: [String: [ChatMessage]]  // sessionKey → messages

    init() {
        self.sessions = []
        self.messages = [:]
    }
}
