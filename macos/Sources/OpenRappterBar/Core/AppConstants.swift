import Foundation

/// Centralized constants for the OpenRappter menu bar app.
public enum AppConstants {
    public static let appName = "OpenRappter"
    public static let bundleId = "com.openrappter.bar"
    public static let version = "1.0.0"
    public static let clientId = "openrappter-bar"
    public static let platform = "macos"
    public static let mode = "menubar"

    // MARK: - Connection

    public static let defaultHost = "127.0.0.1"
    public static let defaultPort = 18790
    public static let defaultWebSocketURL = "ws://\(defaultHost):\(defaultPort)"
    public static let healthEndpointPath = "/health"

    // MARK: - Timeouts (seconds)

    public static let requestTimeout: TimeInterval = 15
    public static let handshakeTimeout: TimeInterval = 10
    public static let healthPollInterval: TimeInterval = 0.5
    public static let healthPollMaxWait: TimeInterval = 15
    public static let gracefulShutdownTimeout: TimeInterval = 5

    // MARK: - Reconnection

    public static let reconnectBaseDelay: TimeInterval = 1.0
    public static let reconnectMaxDelay: TimeInterval = 30.0
    public static let reconnectJitterFactor = 0.25

    // MARK: - Heartbeat

    public static let heartbeatInterval: TimeInterval = 30
    public static let heartbeatTimeout: TimeInterval = 10
    public static let maxMissedHeartbeats = 3

    // MARK: - UI

    public static let maxActivities = 20
    public static let menuWidth: CGFloat = 320
    public static let streamingLineLimit = 6

    // MARK: - Panel / Window

    public static let panelWidth: CGFloat = 380
    public static let panelMinHeight: CGFloat = 420
    public static let panelMaxHeight: CGFloat = 700
    public static let fullWindowWidth: CGFloat = 720
    public static let fullWindowHeight: CGFloat = 520
    public static let fullWindowSidebarWidth: CGFloat = 200
}
