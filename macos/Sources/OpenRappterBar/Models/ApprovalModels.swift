import Foundation

// MARK: - Execution Approval

public struct ExecutionApproval: Codable, Identifiable, Sendable {
    public let id: String
    public let command: String
    public let description: String?
    public let requestedBy: String?
    public let sessionKey: String?
    public let timestamp: Date
    public var status: ApprovalStatus

    public init(
        id: String = UUID().uuidString,
        command: String,
        description: String? = nil,
        requestedBy: String? = nil,
        sessionKey: String? = nil,
        timestamp: Date = Date(),
        status: ApprovalStatus = .pending
    ) {
        self.id = id
        self.command = command
        self.description = description
        self.requestedBy = requestedBy
        self.sessionKey = sessionKey
        self.timestamp = timestamp
        self.status = status
    }
}

public enum ApprovalStatus: String, Codable, Sendable {
    case pending
    case approved
    case denied
    case expired
}
