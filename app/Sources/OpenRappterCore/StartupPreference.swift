import Foundation

/// Shared by the creature, its mind, and the read-only self-check.
public struct StartupPreference: Sendable {
    public let url: URL

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        url = home.appendingPathComponent(".openrappter/no-autostart")
    }

    public var isStopped: Bool { FileManager.default.fileExists(atPath: url.path) }

    public func stop() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("Stopped by the owner.\n".utf8).write(to: url, options: .atomic)
    }

    public func allow() throws {
        if isStopped { try FileManager.default.removeItem(at: url) }
    }
}
