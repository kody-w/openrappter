import Foundation

/// Installs the needs hook into ~/.claude/settings.json so Claude Code's permission prompts show in the notch.
/// Idempotent, keeps every other hook the user has, and copies the script into ~/.openrappter/hooks/.
public enum ClaudeCodeHook {
    public static let scriptName = "openrappter-hook.sh"

    public static func install(from resources: URL) -> String {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let src = resources.appendingPathComponent("hooks/\(scriptName)")
        let dstDir = home.appendingPathComponent(".openrappter/hooks")
        let dst = dstDir.appendingPathComponent(scriptName)
        do {
            try fm.createDirectory(at: dstDir, withIntermediateDirectories: true)
            if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
            try fm.copyItem(at: src, to: dst)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.path)
        } catch { return "Couldn't copy the hook: \(error.localizedDescription)" }

        let settings = home.appendingPathComponent(".claude/settings.json")
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: settings), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { root = obj }
        var hooks = root["hooks"] as? [String: Any] ?? [:]
        let cmd = "~/.openrappter/hooks/\(scriptName)"
        var added: [String] = []
        for event in ["PermissionRequest", "Notification", "Stop"] {
            var entries = hooks[event] as? [[String: Any]] ?? []
            let already = entries.contains { e in
                ((e["hooks"] as? [[String: Any]]) ?? []).contains { ($0["command"] as? String)?.contains(scriptName) == true }
            }
            if !already {
                entries.append(["hooks": [["type": "command", "command": cmd, "timeout": 90]]])
                hooks[event] = entries
                added.append(event)
            }
        }
        root["hooks"] = hooks
        do {
            try fm.createDirectory(at: settings.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: settings, options: .atomic)
        } catch { return "Couldn't write Claude Code settings: \(error.localizedDescription)" }
        return added.isEmpty ? "Claude Code was already connected." : "Connected. Claude Code's prompts now show here (\(added.joined(separator: ", ")))."
    }
}
