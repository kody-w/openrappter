import Foundation

// MARK: - Skill

public struct Skill: Codable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var description: String?
    public var version: String?
    public var author: String?
    public var installed: Bool
    public var enabled: Bool
    public var source: SkillSource

    public init(
        id: String = UUID().uuidString,
        name: String,
        description: String? = nil,
        version: String? = nil,
        author: String? = nil,
        installed: Bool = false,
        enabled: Bool = false,
        source: SkillSource = .local
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.version = version
        self.author = author
        self.installed = installed
        self.enabled = enabled
        self.source = source
    }
}

public enum SkillSource: String, Codable, Sendable {
    case local
    case clawhub
    case builtin
}
