import Foundation

/// Keeps the disk from filling up. Lesson from disk cleaners that lost people's trust: only ever clear
/// caches that rebuild themselves, never documents, photos, mail or iCloud, and say exactly how much came back.
extension Door {
    /// Folders under home that only hold caches the tools rebuild on their own.
    public nonisolated static let rebuildable = [
        "Library/Developer/Xcode/DerivedData",
        "Library/Caches/Homebrew",
        "Library/Caches/pip",
        "Library/Caches/com.apple.dt.Xcode",
        "Library/Caches/org.swift.swiftpm",
        ".npm/_cacache",
        ".cache/pip",
        ".cache/uv",
    ]

    /// Low means under 10 GB free, or under 10% of the disk.
    public nonisolated static func diskLow(free: Int64, total: Int64) -> Bool {
        free < 10_000_000_000 || (total > 0 && free * 10 < total)
    }

    public nonisolated static func gb(_ b: Int64) -> String {
        let g = Double(b) / 1_000_000_000
        return g >= 10 ? "\(Int(g.rounded())) GB" : String(format: "%.1f GB", g)
    }

    nonisolated static func size(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isSymbolicLinkKey], options: []) else { return 0 }
        var n: Int64 = 0
        for case let f as URL in e {
            let v = try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isSymbolicLinkKey])
            if v?.isSymbolicLink == true { continue }
            n += Int64(v?.totalFileAllocatedSize ?? 0)
        }
        return n
    }

    /// Empties the rebuildable folders (keeps the folders themselves) and gives back the bytes cleared.
    public nonisolated static func clearRebuildable(home: URL) -> Int64 {
        var freed: Int64 = 0
        let fm = FileManager.default
        for rel in rebuildable {
            let d = home.appendingPathComponent(rel)
            // Never follow a link out of the cache folder.
            if (try? d.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == true { continue }
            guard let items = try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: nil) else { continue }
            for i in items {
                let s = size(i) + Int64((try? i.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
                if (try? fm.removeItem(at: i)) != nil { freed += s }
            }
        }
        return freed
    }

    /// The biggest folder in home, so the owner knows where the rest went (told, never touched).
    public nonisolated static func biggest(home: URL) -> (name: String, bytes: Int64)? {
        let names = ["Library/Mobile Documents", "Downloads", "Movies", "Pictures", "Documents", "Desktop", "Music", "Library/Containers"]
        let words = ["Library/Mobile Documents": "iCloud Drive", "Library/Containers": "app data"]
        return names.map { (words[$0] ?? $0, size(home.appendingPathComponent($0))) }.max { $0.1 < $1.1 }.flatMap { $0.1 > 0 ? $0 : nil }
    }

    public nonisolated static func diskSays(before: Int64, after: Int64, freed: Int64, biggest: (name: String, bytes: Int64)?, total: Int64) -> String {
        var s = "The disk was nearly full (\(gb(before)) left)."
        s += freed > 0 ? " I cleared \(gb(freed)) of caches that rebuild themselves; \(gb(after)) is free now." : " There were no safe caches to clear."
        if diskLow(free: after, total: total) {
            s += " It is still low"
            if let b = biggest { s += "; the biggest folder is \(b.name) at \(gb(b.bytes))" }
            s += ". What to remove there is yours to choose"
        }
        return s
    }

    var diskURL: URL { dir.appendingPathComponent("disk.json") }

    /// Called on every heartbeat. Looks once an hour; clears and tells at most once a day.
    public func keepDisk(now: Date, home: URL = FileManager.default.homeDirectoryForCurrentUser,
                         space: (() -> (free: Int64, total: Int64))? = nil) {
        let last = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: diskURL))) as? [String: Any]) ?? [:]
        let t = now.timeIntervalSince1970
        guard t - (last["looked"] as? Double ?? 0) >= 3600 else { return }
        let read = space ?? {
            let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
            return (v?.volumeAvailableCapacityForImportantUsage ?? Int64.max, Int64(v?.volumeTotalCapacity ?? 0))
        }
        let (free, total) = read()
        var keep: [String: Any] = ["looked": t, "free": free, "told": last["told"] as? Double ?? 0]
        defer { if let d = try? JSONSerialization.data(withJSONObject: keep, options: [.sortedKeys]) { try? d.write(to: diskURL, options: .atomic) } }
        guard Door.diskLow(free: free, total: total), t - (keep["told"] as? Double ?? 0) >= 86400 else { return }
        let freed = Door.clearRebuildable(home: home)
        let after = space == nil ? read().free : free + freed
        let said = Door.diskSays(before: free, after: after, freed: freed,
                                 biggest: Door.diskLow(free: after, total: total) ? Door.biggest(home: home) : nil, total: total)
        keep["told"] = t
        var ask = DoorAsk(id: "notice-\(Int(t))-disk", do: "notice"); ask.app = "this Mac"
        record(ask, DoorAnswer(id: ask.id, ok: true, said: said, front: nil, words: nil, picture: nil, at: t))
        onAct?("the disk was nearly full"); onDone?()
    }
}
