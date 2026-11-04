import Foundation

/// Only for the creature's own machinery-derived copy, never another speaker's words.
public enum OwnerWords {
    private static let replacements = [
        "kernel": "mind", "launchd": "sign-in helper", "plist": "saved setting",
        "json": "saved text", "http": "connection", "https": "link", "port": "address",
        "socket": "link", "token": "sign-in detail", "process": "task", "pid": "task number",
        "405": "sign-in trouble", "bootstrap": "setup", "daemon": "helper", "endpoint": "address",
        "stderr": "notes", "stdout": "notes", "exit code": "result",
    ]
    public static func plain(_ text: String) -> String {
        replacements.sorted { $0.key.count > $1.key.count }.reduce(text) { result, pair in
            result.replacingOccurrences(of: "\\b\(NSRegularExpression.escapedPattern(for: pair.key))\\b",
                                        with: pair.value, options: [.regularExpression, .caseInsensitive])
        }
    }
}
