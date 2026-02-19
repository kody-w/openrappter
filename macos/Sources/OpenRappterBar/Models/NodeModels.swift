import Foundation

// MARK: - Node (Connected Device / Instance)

public struct Node: Codable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var host: String
    public var port: Int
    public var status: NodeStatus
    public var platform: String?
    public var version: String?
    public var lastSeen: Date?
    public var connectionId: String?

    public init(
        id: String = UUID().uuidString,
        name: String,
        host: String,
        port: Int,
        status: NodeStatus = .offline,
        platform: String? = nil,
        version: String? = nil,
        lastSeen: Date? = nil,
        connectionId: String? = nil
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.status = status
        self.platform = platform
        self.version = version
        self.lastSeen = lastSeen
        self.connectionId = connectionId
    }
}

public enum NodeStatus: String, Codable, Sendable {
    case online
    case offline
    case busy
    case error
}
