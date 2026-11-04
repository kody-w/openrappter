import Foundation

/// A thing that needs the human. Same shape as the rapp-tower decision card, so the morning run and
/// any tool (a Claude Code hook, a script) can drop one as a JSON file in ~/.openrappter/needs/.
public struct NeedOption: Codable, Equatable, Sendable {
    public var label: String
    public var rec: Bool?
    public var action: String?
    public init(label: String, rec: Bool? = nil, action: String? = nil) { self.label = label; self.rec = rec; self.action = action }
}

public struct Need: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var ctx: String?
    public var opts: [NeedOption]
    public var source: String?
    public var created: Double?
    public init(id: String, title: String, ctx: String? = nil, opts: [NeedOption], source: String? = nil, created: Double? = nil) {
        self.id = id; self.title = title; self.ctx = ctx; self.opts = opts; self.source = source; self.created = created
    }
}

public struct NeedAnswer: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var action: String?
    public var answered: Double
}

/// Watches the needs folder. A need is open while `<id>.json` exists and `<id>.answer.json` does not.
@MainActor
public final class NeedsQueue: ObservableObject {
    @Published public private(set) var needs: [Need] = []
    /// FYI notes (one plain OK, nothing to decide): they never pop the notch; they flow here, newest first.
    @Published public private(set) var stream: [Need] = []
    public let dir: URL
    private var fd: Int32 = -1
    private var source: DispatchSourceFileSystemObject?
    private var snoozed: Set<String> = []
    private var reloadPending = false
    private var tick: Timer?
    private var firstSeen: [String: Double] = [:]

    public init(dir: URL? = nil) {
        self.dir = dir ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/needs")
        try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true)
        reload()
        watch()
        tick = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.reload() } }
    }

    public func reload() {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        let answered = Set(files.filter { $0.lastPathComponent.hasSuffix(".answer.json") }
            .map { $0.lastPathComponent.replacingOccurrences(of: ".answer.json", with: "") })
        // Keep the folder small: answered cards and notices older than two days move to needs/archive (never deleted).
        let archive = dir.appendingPathComponent("archive")
        let stale = Date().addingTimeInterval(-2 * 86400)
        func shelve(_ f: URL) {
            try? fm.createDirectory(at: archive, withIntermediateDirectories: true)
            let to = archive.appendingPathComponent(f.lastPathComponent)
            try? fm.removeItem(at: to); try? fm.moveItem(at: f, to: to)
        }
        var found: [Need] = []
        for f in files where f.pathExtension == "json" && !f.lastPathComponent.hasSuffix(".answer.json") {
            guard let data = try? Data(contentsOf: f), let n = try? JSONDecoder().decode(Need.self, from: data) else { continue }
            if answered.contains(n.id) {
                if let at = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, at < Date().addingTimeInterval(-600) {
                    shelve(f); shelve(dir.appendingPathComponent("\(n.id).answer.json"))
                }
                continue
            }
            if n.source != "doors", let at = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, at < stale { shelve(f); continue }
            if snoozed.contains(n.id) { continue }
            found.append(n)
        }
        // Only when Kody is needed does a card pop: an FYI settles at once and joins the quiet stream.
        let fyi = found.filter { $0.source != "doors" && $0.opts.count == 1 && $0.opts[0].action == nil }
        if !fyi.isEmpty {
            for n in fyi { autoAnswer(n) }
            let ids = Set(fyi.map(\.id))
            stream = (fyi + stream.filter { !ids.contains($0.id) }).sorted { ($0.created ?? 0) > ($1.created ?? 0) }.prefix(15).map { $0 }
            found.removeAll { ids.contains($0.id) }
        }
        // Object, don't confirm (Kody 2026-11-02): a card left alone takes its recommended option on its own.
        // FYI cards (one OK) fade after 30 seconds; cards with a real choice after 10. Door requests are not touched here.
        // Only the newest "finished" note per session stays on screen.
        let nowT = Date().timeIntervalSince1970
        for n in found where firstSeen[n.id] == nil { firstSeen[n.id] = (n.created ?? nowT) > nowT - 86400 ? (n.created ?? nowT) : nowT }
        var newestPerSession: [String: Need] = [:]
        var kept: [Need] = []
        for n in found {
            if n.source == "claude-code", let sess = n.id.split(separator: "-").dropFirst().first.map(String.init) {
                if let cur = newestPerSession[sess], (cur.created ?? 0) >= (n.created ?? 0) { autoAnswer(n); continue }
                if let old = newestPerSession[sess] { autoAnswer(old); kept.removeAll { $0.id == old.id } }
                newestPerSession[sess] = n
            }
            kept.append(n)
        }
        found = kept.filter { n in
            guard n.source != "doors", let rec = n.opts.first(where: { $0.rec == true }) ?? (n.opts.count == 1 ? n.opts.first : nil),
                  let c = firstSeen[n.id] ?? min(n.created ?? .infinity, Date().timeIntervalSince1970) as Double? else { return true }
            let wait: TimeInterval = n.opts.count == 1 ? 30 : 600
            if Date().timeIntervalSince1970 - c > wait { write(n, rec, by: "default"); return false }
            return true
        }
        // A door request has a caller waiting on the socket: it goes before older notices, then oldest first.
        needs = found.sorted { a, b in
            let da = a.source == "doors", db = b.source == "doors"
            return da != db ? da : (a.created ?? 0) < (b.created ?? 0)
        }
    }

    public var top: Need? { needs.first }

    public func answer(_ need: Need, _ opt: NeedOption) {
        let a = NeedAnswer(id: need.id, label: opt.label, action: opt.action, answered: Date().timeIntervalSince1970)
        let url = dir.appendingPathComponent("\(need.id).answer.json")
        do { try JSONEncoder().encode(a).write(to: url, options: .atomic) }
        catch { NSLog("OpenRappter could not save a choice: %@", error.localizedDescription) }
        reload()
    }

    private func autoAnswer(_ n: Need) {
        if let rec = n.opts.first(where: { $0.rec == true }) ?? n.opts.first { write(n, rec, by: "default") }
    }
    private func write(_ need: Need, _ opt: NeedOption, by: String) {
        let a = NeedAnswer(id: need.id, label: opt.label, action: opt.action, answered: Date().timeIntervalSince1970)
        if let data = try? JSONEncoder().encode(a) { try? data.write(to: dir.appendingPathComponent("\(need.id).answer.json"), options: .atomic) }
    }

    public func later(_ need: Need) { snoozed.insert(need.id); reload() }

    /// Drop a need from inside the app (or a test).
    @discardableResult
    public func add(_ need: Need) -> URL {
        let url = dir.appendingPathComponent("\(need.id).json")
        if let data = try? JSONEncoder().encode(need) { try? data.write(to: url, options: .atomic) }
        reload()
        return url
    }

    private func watch() {
        fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename], queue: .main)
        // Coalesce bursts of file events into one reload a quarter second later.
        s.setEventHandler { [weak self] in
            guard let self, !self.reloadPending else { return }
            self.reloadPending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.reloadPending = false; self?.reload() }
        }
        s.setCancelHandler { [fd = self.fd] in close(fd) }
        s.resume()
        source = s
    }
}
