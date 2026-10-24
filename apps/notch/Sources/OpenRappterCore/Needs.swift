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
    public let dir: URL
    private var fd: Int32 = -1
    private var source: DispatchSourceFileSystemObject?
    private var snoozed: Set<String> = []

    public init(dir: URL? = nil) {
        self.dir = dir ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/needs")
        try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true)
        reload()
        watch()
    }

    public func reload() {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        let answered = Set(files.filter { $0.lastPathComponent.hasSuffix(".answer.json") }
            .map { $0.lastPathComponent.replacingOccurrences(of: ".answer.json", with: "") })
        var found: [Need] = []
        for f in files where f.pathExtension == "json" && !f.lastPathComponent.hasSuffix(".answer.json") {
            guard let data = try? Data(contentsOf: f), let n = try? JSONDecoder().decode(Need.self, from: data) else { continue }
            if answered.contains(n.id) || snoozed.contains(n.id) { continue }
            found.append(n)
        }
        needs = found.sorted { ($0.created ?? 0) < ($1.created ?? 0) }
    }

    public var top: Need? { needs.first }

    public func answer(_ need: Need, _ opt: NeedOption) {
        let a = NeedAnswer(id: need.id, label: opt.label, action: opt.action, answered: Date().timeIntervalSince1970)
        let url = dir.appendingPathComponent("\(need.id).answer.json")
        let tmp = dir.appendingPathComponent(".\(need.id).answer.json.tmp")
        if let data = try? JSONEncoder().encode(a) {
            try? data.write(to: tmp)
            _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)   // atomic: a waiting hook never sees a half file
        }
        reload()
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
        s.setEventHandler { [weak self] in self?.reload() }
        s.setCancelHandler { [fd = self.fd] in close(fd) }
        s.resume()
        source = s
    }
}
