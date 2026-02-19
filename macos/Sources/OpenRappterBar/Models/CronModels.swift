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
