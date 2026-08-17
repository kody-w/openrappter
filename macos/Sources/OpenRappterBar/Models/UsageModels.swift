import Foundation

// MARK: - Usage Statistics

public struct UsageStats: Codable, Sendable {
    public let totalTokens: Int
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalCost: Double
    public let requestCount: Int
    public let period: String?
    /// Whether `totalCost` is a measurement at all.
    ///
    /// This runtime holds no per-token price table for any provider, and the
    /// default backend is a Copilot subscription that has no per-token price.
    /// The gateway therefore sends `costAvailable: false` and `totalCost: 0`.
    /// Rendering that as "$0.0000" would present a number nobody measured, so
    /// `formattedCost` says so instead. Absent (older gateway) is treated as
    /// unknown for the same reason.
    public let costAvailable: Bool?

    public init(
        totalTokens: Int = 0,
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        totalCost: Double = 0,
        requestCount: Int = 0,
        period: String? = nil,
        costAvailable: Bool? = nil
    ) {
        self.totalTokens = totalTokens
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalCost = totalCost
        self.requestCount = requestCount
        self.period = period
        self.costAvailable = costAvailable
    }

    /// Formatted cost string (e.g., "$0.0042"), or "n/a" when nothing priced it.
    public var formattedCost: String {
        guard costAvailable == true else { return "n/a" }
        return String(format: "$%.4f", totalCost)
    }

    /// Formatted token count (e.g., "12.3K")
    public var formattedTokens: String {
        if totalTokens >= 1_000_000 {
            return String(format: "%.1fM", Double(totalTokens) / 1_000_000)
        } else if totalTokens >= 1_000 {
            return String(format: "%.1fK", Double(totalTokens) / 1_000)
        }
        return "\(totalTokens)"
    }
}

// MARK: - Usage Entry (per-request)

public struct UsageEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let timestamp: Date
    public let model: String
    public let tokens: Int
    public let cost: Double
    public let sessionKey: String?

    public init(
        id: String = UUID().uuidString,
        timestamp: Date = Date(),
        model: String,
        tokens: Int,
        cost: Double,
        sessionKey: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.model = model
        self.tokens = tokens
        self.cost = cost
        self.sessionKey = sessionKey
    }
}
