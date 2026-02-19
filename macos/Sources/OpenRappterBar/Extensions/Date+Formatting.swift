import Foundation

extension Date {
    /// Relative time description (e.g. "2m ago", "1h ago", "yesterday").
    public var relativeDescription: String {
        let interval = -timeIntervalSinceNow
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        if interval < 172800 { return "yesterday" }
        return "\(Int(interval / 86400))d ago"
    }
}
