import Foundation

extension String {
    /// Truncate the string to a maximum length, appending an ellipsis if needed.
    public func truncated(to maxLength: Int, trailing: String = "...") -> String {
        if count <= maxLength {
            return self
        }
        return String(prefix(maxLength - trailing.count)) + trailing
    }
}
