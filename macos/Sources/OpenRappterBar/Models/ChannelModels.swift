import Foundation

// MARK: - Channel

public struct Channel: Codable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var type: ChannelType
    public var enabled: Bool
    public var config: [String: AnyCodable]?
    public var status: ChannelStatus

    public init(
        id: String = UUID().uuidString,
        name: String,
        type: ChannelType,
        enabled: Bool = false,
        config: [String: AnyCodable]? = nil,
        status: ChannelStatus = .disconnected
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.enabled = enabled
        self.config = config
        self.status = status
    }
}

public enum ChannelType: String, Codable, Sendable, CaseIterable {
    case cli
    case slack
    case discord
    case telegram
    case signal
    case imessage
    case googleChat = "google_chat"
    case teams
    case whatsapp
    case matrix
}

public enum ChannelStatus: String, Codable, Sendable {
    case connected
    case disconnected
    case error
    case connecting
}

// MARK: - Channel Message

public struct ChannelMessage: Codable, Identifiable, Sendable {
    public let id: String
    public let channelId: String
    public let sender: String
    public let content: String
    public let timestamp: Date

    public init(
        id: String = UUID().uuidString,
        channelId: String,
        sender: String,
        content: String,
        timestamp: Date = Date()
    ) {
        self.id = id
        self.channelId = channelId
        self.sender = sender
        self.content = content
        self.timestamp = timestamp
    }
}
