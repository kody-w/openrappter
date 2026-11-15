import Foundation

/// A learned job that stopped fitting this Mac: the thing a step needs is no longer there.
public struct DoorMisfit: Codable, Equatable {
    public var job: String       // the job, as it was named when it was run
    public var at: Double        // when it last stopped this way
    public var step: Int         // which step, counting from 1
    public var reason: String    // plain words: "I could not find Export"
    public var saw: [String]     // what the screen offered instead, up to six button names
    public var steps: String     // a fingerprint of the steps it was run with; new steps make the mark stale
}

/// Telling the owner when a job stopped fitting. Apps update and a button gets renamed; a job that
/// keeps failing on a clock helps no one, so it is set aside, said once, and left for the owner.
/// The old steps are never touched.
extension Door {
    /// Kept beside the learned jobs. No ".json" ending, so it is never mistaken for a job.
    var fitURL: URL { learned.appendingPathComponent(".no-longer-fits") }

    // MARK: the decisions, pure

    /// Reads a job's answer. When it stopped because the thing a step needs is not there, gives the step and why.
    /// Nil for everything else: a job that worked, hands off, not being allowed yet, or an ask with parts missing.
    public nonisolated static func misfit(_ said: String) -> (step: Int, reason: String)? {
        guard let cut = said.range(of: " stopped at step ") else { return nil }
        let tail = said[cut.upperBound...]
        guard let colon = tail.range(of: ": "), let step = Int(tail[..<colon.lowerBound]), step > 0 else { return nil }
        let why = String(tail[colon.upperBound...])
        func after(_ lead: String) -> String? {
            guard why.hasPrefix(lead) else { return nil }
            let rest = why.dropFirst(lead.count).trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? nil : rest
        }
        if let what = after("nothing on screen says ") { return (step, "I could not find \(what)") }
        if why == "that app is not running" { return (step, "the app it needs is not open") }
        let closed = " is not open, so I did not touch anything"
        if why.hasSuffix(closed), why.count > closed.count { return (step, "\(why.dropLast(closed.count)) is not open") }
        if let rest = after("could not bring "), let end = rest.range(of: " to the front"), end.lowerBound > rest.startIndex {
            return (step, "I could not bring \(rest[..<end.lowerBound]) to the front")
        }
        if let what = after("could not find ") { return (step, "I could not find \(what)") }
        return nil
    }

    /// The button names in what the screen says, in order, each once, without where they sit.
    public nonisolated static func offered(_ words: [String], limit: Int = 6) -> [String] {
        let dull: Set<String> = ["close button", "minimize button", "zoom button", "full screen button"]
        var out: [String] = []
        for w in words where w.hasPrefix("Button: ") {
            var name = String(w.dropFirst(8))
            if let spot = name.range(of: " @", options: .backwards),
               name[spot.upperBound...].allSatisfy({ $0.isNumber || $0 == "," || $0 == "-" }) { name = String(name[..<spot.lowerBound]) }
            name = name.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !dull.contains(name.lowercased()), !out.contains(name) else { continue }
            out.append(name)
            if out.count >= limit { break }
        }
        return out
    }

    /// The one sentence the owner reads.
    public nonisolated static func fitSays(_ m: DoorMisfit) -> String {
        "\(m.job) no longer fits this Mac: at step \(m.step) \(m.reason)." + (m.saw.isEmpty ? "" : " I can see: \(m.saw.joined(separator: ", ")).")
    }

    /// Of the watches that are due, the ones whose job still fits.
    public nonisolated static func runnable(_ due: [DoorWatch], misfits: Set<String>, slug: (String) -> String) -> [DoorWatch] {
        due.filter { !misfits.contains(slug($0.job)) }
    }

    nonisolated static func fingerprint(_ data: Data?) -> String {
        guard let data else { return "" }
        var h: UInt64 = 0xcbf29ce484222325
        for b in data { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(h, radix: 16)
    }

    // MARK: the marks

    /// Every job marked as no longer fitting, by its file name. A mark whose job is gone, or whose steps have
    /// been replaced since, no longer counts.
    public func misfits() -> [String: DoorMisfit] {
        let all = (try? JSONDecoder().decode([String: DoorMisfit].self, from: Data(contentsOf: fitURL))) ?? [:]
        return all.filter { key, m in
            guard let d = try? Data(contentsOf: learned.appendingPathComponent("\(key).json")) else { return false }
            return Door.fingerprint(d) == m.steps
        }
    }

    func saveMisfits(_ all: [String: DoorMisfit]) {
        if all.isEmpty { try? FileManager.default.removeItem(at: fitURL); return }
        try? FileManager.default.createDirectory(at: learned, withIntermediateDirectories: true)
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(all).write(to: fitURL, options: .atomic)
    }

    public func misfit(of job: String) -> DoorMisfit? { misfits()[slug(job)] }
    /// True when a watch, or covering for another Mac, should leave this job alone.
    public func fitSkips(_ job: String) -> Bool { misfit(of: job) != nil }
    public func fitRunnable(_ due: [DoorWatch]) -> [DoorWatch] {
        Door.runnable(due, misfits: Set(misfits().keys)) { self.slug($0) }
    }
    /// Takes the mark off, so watches run the job again.
    public func fitClear(_ job: String) {
        var all = misfits()
        guard all.removeValue(forKey: slug(job)) != nil else { return }
        saveMisfits(all)
    }

    /// Called after every run of a learned job. A run that went through clears the mark. A run that stopped because
    /// something is not there sets it, and says so once: the first time, not on every later try.
    func fitAfter(_ job: String, _ steps: [DoorAsk], _ ans: DoorAnswer) {
        if ans.ok { fitClear(job); return }
        guard let found = Door.misfit(ans.said), let url = learnedURL(job) else { return }
        let step = steps.indices.contains(found.step - 1) ? steps[found.step - 1] : nil
        var reason = found.reason
        if reason == "the app it needs is not open", let app = step?.app, !app.isEmpty { reason = "\(app) is not open" }
        var all = misfits()
        let first = all[slug(job)] == nil
        let m = DoorMisfit(job: job, at: ans.at, step: found.step, reason: reason, saw: Door.offered(fitWords(step?.app)),
                           steps: Door.fingerprint(try? Data(contentsOf: url)))
        all[slug(job)] = m
        saveMisfits(all)
        guard first else { return }
        var note = DoorAsk(id: "notice-\(Int(ans.at))-fit-\(slug(job))", do: "notice"); note.title = job
        let said = Door.fitSays(m) + " I have set it aside until you show me again"
        record(note, DoorAnswer(id: note.id, ok: true, said: said, front: nil, words: m.saw, picture: nil, at: ans.at))
        onAct?("\(job) no longer fits this Mac"); onDone?()
    }

    // MARK: the page and the ask

    /// The "Left for you" rows: one per job that no longer fits and that the owner has not said to leave.
    func fitRows() -> [(says: String, buttons: [(label: String, ask: DoorAsk)])] {
        let left = Set((try? JSONDecoder().decode([String].self, from: Data(contentsOf: dir.appendingPathComponent("forgotten.json")))) ?? [])
        return misfits().sorted { $0.value.at < $1.value.at }.compactMap { key, m in
            let leaveKey = "fit-\(key)-\(Int(m.at))"
            guard !left.contains(leaveKey) else { return nil }
            var show = DoorAsk(id: "", do: "show"); show.title = m.job
            var again = DoorAsk(id: "", do: "job"); again.title = m.job
            var leave = DoorAsk(id: "", do: "forget"); leave.text = leaveKey
            return (Door.fitSays(m), [("Show it again", show), ("Try it again", again), ("Leave it", leave)])
        }
    }

    /// The ask "fits": every learned job, and whether it still fits this Mac.
    func fitsAsk(_ ans: inout DoorAnswer) {
        let marks = misfits()
        let names = ((try? FileManager.default.contentsOfDirectory(at: learned, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" && !$0.lastPathComponent.hasPrefix(".") }
            .map { $0.deletingPathExtension().lastPathComponent }.sorted()
        ans.words = names.map { key in
            let plain = key.replacingOccurrences(of: "-", with: " ")
            guard let m = marks[key] else { return "\(plain): fits" }
            return "\(plain): does not fit. At step \(m.step) \(m.reason)" + (m.saw.isEmpty ? "" : ". I can see: \(m.saw.joined(separator: ", "))")
        }
        let bad = names.filter { marks[$0] != nil }.count
        ans.ok = true
        ans.said = names.isEmpty ? "I have not learned any jobs yet"
            : bad == 0 ? "all \(names.count) jobs I know still fit this Mac"
            : "\(bad) of the \(names.count) jobs I know no longer fit\(bad == 1 ? "s" : "") this Mac"
    }
}
