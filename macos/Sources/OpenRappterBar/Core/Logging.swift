import os

/// Structured logging using Apple's os.Logger with predefined subsystem and categories.
public enum Log {
    private static let subsystem = AppConstants.bundleId

    /// Connection and WebSocket events
    public static let connection = Logger(subsystem: subsystem, category: "connection")

    /// RPC requests and responses
    public static let rpc = Logger(subsystem: subsystem, category: "rpc")

    /// Gateway process lifecycle
    public static let process = Logger(subsystem: subsystem, category: "process")

    /// Heartbeat monitoring
    public static let heartbeat = Logger(subsystem: subsystem, category: "heartbeat")

    /// Event bus distribution
    public static let events = Logger(subsystem: subsystem, category: "events")

    /// General app lifecycle
    public static let app = Logger(subsystem: subsystem, category: "app")
}
