import Foundation

// MARK: - App Settings

public struct AppSettings: Codable, Sendable {
    public var connection: ConnectionSettings
    public var ui: UISettings
    public var session: SessionSettings

    public init(
        connection: ConnectionSettings = .init(),
        ui: UISettings = .init(),
        session: SessionSettings = .init()
    ) {
        self.connection = connection
        self.ui = ui
        self.session = session
    }
}

// MARK: - Connection Settings

public struct ConnectionSettings: Codable, Sendable {
    public var host: String
    public var port: Int
    public var autoConnect: Bool
    public var autoStartGateway: Bool

    public init(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort,
        autoConnect: Bool = true,
        autoStartGateway: Bool = false
    ) {
        self.host = host
        self.port = port
        self.autoConnect = autoConnect
        self.autoStartGateway = autoStartGateway
    }
}

// MARK: - UI Settings

public struct UISettings: Codable, Sendable {
    public var showInDock: Bool
    public var compactMode: Bool

    public init(
        showInDock: Bool = false,
        compactMode: Bool = false
    ) {
        self.showInDock = showInDock
        self.compactMode = compactMode
    }
}

// MARK: - Session Settings

public struct SessionSettings: Codable, Sendable {
    public var maxSessions: Int
    public var autoDeleteAfterDays: Int?

    public init(
        maxSessions: Int = 50,
        autoDeleteAfterDays: Int? = nil
    ) {
        self.maxSessions = maxSessions
        self.autoDeleteAfterDays = autoDeleteAfterDays
    }
}
