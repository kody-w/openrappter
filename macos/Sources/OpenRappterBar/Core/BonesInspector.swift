import Foundation

/// The files that actually make up this AI, read from disk.
///
/// This is the openrappter answer to the brainstem's "click it and see what you
/// are made of". The rule that makes it worth having is that everything here is
/// read from the running organism at the moment you ask — nothing is hardcoded,
/// nothing is a sample, and a section that finds nothing says so rather than
/// showing a plausible-looking placeholder.
///
/// That matters more than it sounds. A mock inventory would be worse than no
/// inventory: it would tell you your agent exists when it does not, and the
/// entire point of opening the bones is to find out what is really there.
public struct Bones: Sendable {
    public struct Item: Sendable, Identifiable {
        public let id: String
        public let name: String
        public let path: String
        public let bytes: Int
        public let modified: Date?
        /// True when the file was expected but is not present.
        public let missing: Bool

        public var sizeLabel: String {
            if missing { return "—" }
            if bytes < 1024 { return "\(bytes) B" }
            if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
            return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
        }
    }

    public struct Section: Sendable, Identifiable {
        public let id: String
        public let title: String
        /// What this part of the organism is for, in one line.
        public let blurb: String
        public let root: String
        public let items: [Item]
        /// Shown when `items` is empty — the truthful "there is nothing here".
        public let emptyNote: String
    }

    public let home: String
    public let sections: [Section]

    public var totalFiles: Int { sections.reduce(0) { $0 + $1.items.filter { !$0.missing }.count } }
    public var totalBytes: Int { sections.reduce(0) { $0 + $1.items.reduce(0) { $0 + $1.bytes } } }
}

public enum BonesInspector {

    /// Read the organism as it exists right now.
    public static func inspect(
        home: String = NSHomeDirectory() + "/.openrappter",
        fileManager: FileManager = .default
    ) -> Bones {
        var sections: [Bones.Section] = []

        // ── Agents: what it can DO ──────────────────────────────────────────
        let agentsDir = home + "/agents"
        sections.append(
            Bones.Section(
                id: "agents",
                title: "Agents",
                blurb: "Single-file capabilities. Each one is a thing this AI can do.",
                root: agentsDir,
                items: files(in: agentsDir, matching: [".js", ".py", ".ts"], fileManager: fileManager),
                emptyNote: "No agents installed yet. Build one with the Brain Surgeon."
            ))

        // ── Skills ──────────────────────────────────────────────────────────
        let skillsDir = home + "/skills"
        sections.append(
            Bones.Section(
                id: "skills",
                title: "Skills",
                blurb: "SKILL.md instructions loaded as agents at runtime.",
                root: skillsDir,
                items: skillFiles(in: skillsDir, fileManager: fileManager),
                emptyNote: "No skills installed."
            ))

        // ── Identity: who it thinks it is ───────────────────────────────────
        // Listed even when absent, because "you have no SOUL.md" is itself the
        // useful answer — it explains why the assistant sounds generic.
        let identityNames = ["SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"]
        sections.append(
            Bones.Section(
                id: "identity",
                title: "Identity",
                blurb: "Who this AI believes it is. Read into every prompt it sends.",
                root: home,
                items: identityNames.map { named($0, in: home, fileManager: fileManager) },
                emptyNote: "No identity files."
            ))

        // ── Memory ──────────────────────────────────────────────────────────
        sections.append(
            Bones.Section(
                id: "memory",
                title: "Memory",
                blurb: "What it has been told and kept.",
                root: home,
                items: [
                    named("memory.json", in: home, fileManager: fileManager),
                    named("sessions.json", in: home, fileManager: fileManager),
                ],
                emptyNote: "Nothing remembered yet."
            ))

        // ── Configuration ───────────────────────────────────────────────────
        // `.env` is listed by name and size only. Its contents are never read
        // here — the whole point of the GOD layer is that credentials stay on
        // device and out of any surface that could be screenshotted or shared.
        sections.append(
            Bones.Section(
                id: "config",
                title: "Configuration",
                blurb: "Settings and credentials. Names and sizes only — never contents.",
                root: home,
                items: [
                    named("config.json", in: home, fileManager: fileManager),
                    named(".env", in: home, fileManager: fileManager),
                ],
                emptyNote: "No configuration written."
            ))

        return Bones(home: home, sections: sections)
    }

    /// Files that should never be opened from the inspector, whatever the user clicks.
    public static func isSecret(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent.lowercased()
        return name == ".env" || name.hasPrefix(".env.") || name.contains("credential") || name.contains("token")
    }

    // MARK: - Reading

    private static func named(_ name: String, in dir: String, fileManager: FileManager) -> Bones.Item {
        let path = (dir as NSString).appendingPathComponent(name)
        let attrs = try? fileManager.attributesOfItem(atPath: path)
        let exists = fileManager.fileExists(atPath: path)
        return Bones.Item(
            id: path,
            name: name,
            path: path,
            bytes: (attrs?[.size] as? NSNumber)?.intValue ?? 0,
            modified: attrs?[.modificationDate] as? Date,
            missing: !exists
        )
    }

    private static func files(
        in dir: String, matching suffixes: [String], fileManager: FileManager
    ) -> [Bones.Item] {
        guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { return [] }
        return entries
            .filter { name in suffixes.contains { name.hasSuffix($0) } }
            .sorted()
            .map { named($0, in: dir, fileManager: fileManager) }
    }

    private static func skillFiles(in dir: String, fileManager: FileManager) -> [Bones.Item] {
        guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [Bones.Item] = []
        for entry in entries.sorted() where !entry.hasPrefix(".") {
            let skillPath = (dir as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: skillPath, isDirectory: &isDir), isDir.boolValue
            else { continue }
            let md = (skillPath as NSString).appendingPathComponent("SKILL.md")
            guard fileManager.fileExists(atPath: md) else { continue }
            let attrs = try? fileManager.attributesOfItem(atPath: md)
            out.append(
                Bones.Item(
                    id: md,
                    name: entry,
                    path: md,
                    bytes: (attrs?[.size] as? NSNumber)?.intValue ?? 0,
                    modified: attrs?[.modificationDate] as? Date,
                    missing: false
                ))
        }
        return out
    }
}
