import Foundation

// MARK: - Cron Job

public struct CronJob: Codable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var schedule: String  // cron expression
    public var command: String
    public var enabled: Bool
    public var lastRun: Date?
    public var nextRun: Date?
    public var lastResult: CronResult?

    public init(
        id: String = UUID().uuidString,
        name: String,
        schedule: String,
        command: String,
        enabled: Bool = true,
        lastRun: Date? = nil,
        nextRun: Date? = nil,
        lastResult: CronResult? = nil
    ) {
        self.id = id
        self.name = name
        self.schedule = schedule
        self.command = command
        self.enabled = enabled
        self.lastRun = lastRun
        self.nextRun = nextRun
        self.lastResult = lastResult
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, schedule, command, message, enabled, lastRun, nextRun, lastResult
    }

    /// The gateway calls this field `message`; this app has always called it
    /// `command`. Decoding both means a listing from a gateway that only speaks
    /// the canonical name still produces a job with its prompt intact, instead
    /// of falling through to the lossy manual parse in `RpcClient`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        schedule = try c.decode(String.self, forKey: .schedule)
        command = try c.decodeIfPresent(String.self, forKey: .command)
            ?? c.decodeIfPresent(String.self, forKey: .message)
            ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        lastRun = try c.decodeIfPresent(Date.self, forKey: .lastRun)
        nextRun = try c.decodeIfPresent(Date.self, forKey: .nextRun)
        lastResult = try c.decodeIfPresent(CronResult.self, forKey: .lastResult)
    }

    /// Writes both spellings for the same reason the decoder reads both.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(schedule, forKey: .schedule)
        try c.encode(command, forKey: .message)
        try c.encode(command, forKey: .command)
        try c.encode(enabled, forKey: .enabled)
        try c.encodeIfPresent(lastRun, forKey: .lastRun)
        try c.encodeIfPresent(nextRun, forKey: .nextRun)
        try c.encodeIfPresent(lastResult, forKey: .lastResult)
    }
}

public enum CronResult: String, Codable, Sendable {
    case success
    case failure
    case skipped
}

// MARK: - Cron Execution Log

public struct CronExecutionLog: Codable, Identifiable, Sendable {
    public let id: String
    public let jobId: String
    public let timestamp: Date
    public let result: CronResult
    public let output: String?
    public let duration: TimeInterval?

    public init(
        id: String = UUID().uuidString,
        jobId: String,
        timestamp: Date = Date(),
        result: CronResult,
        output: String? = nil,
        duration: TimeInterval? = nil
    ) {
        self.id = id
        self.jobId = jobId
        self.timestamp = timestamp
        self.result = result
        self.output = output
        self.duration = duration
    }
}
