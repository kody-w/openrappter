import AppKit

/// It brings the screen to you. When another of the owner's Macs has a box only the owner may press
/// (a password or a permission), the Mac the owner is sitting at opens that Mac's screen and says why.
/// The door still never presses those boxes itself.
extension Door {
    /// How long between two screens being opened, so they never pile up.
    public nonisolated static let bringGap: TimeInterval = 60

    // MARK: the Mac that has the box

    /// What this Mac needs from its owner right now: one entry per waiting box that guards the Mac.
    /// Only the words the box shows and a name for it that stays the same while it is up. No buttons, no offers.
    public func needs() -> [[String: String]] {
        let waiting = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: waitingURL))) as? [[String: Any]]) ?? []
        return Door.needs(from: waiting)
    }
    public static func needs(from waiting: [[String: Any]]) -> [[String: String]] {
        var out: [[String: String]] = [], seen: Set<String> = []
        for b in waiting {
            guard let app = b["app"] as? String, gates.contains(app) else { continue }
            let id = "\(app.lowercased().filter { $0.isLetter || $0.isNumber })-\(Int(b["since"] as? Double ?? 0))"
            guard seen.insert(id).inserted else { continue }
            out.append(["id": id, "says": String(boxSays((b["words"] as? [String]) ?? []).prefix(200))])
        }
        return out
    }

    /// The line on the page under a box that guards the Mac: it is the owner's to press.
    public static func yoursToPress(otherMacs: Bool) -> String {
        "This one is yours to press. I never press the boxes that guard this Mac." + (otherMacs ? " Your other Mac will bring this screen up for you." : "")
    }
    /// A page row for a waiting box, with the "yours to press" line added when the box guards the Mac.
    static func yours(_ row: String, app: String, otherMacs: Bool) -> String {
        guard gates.contains(app) else { return row }
        let line = "<br><span style=\"opacity:.7;white-space:normal\">\(yoursToPress(otherMacs: otherMacs))</span>"
        return row.hasSuffix("<div>") ? String(row.dropLast(5)) + line + "<div>" : row + line
    }

    // MARK: the Mac the owner is sitting at

    /// Which of another Mac's needs to act on now, and which already-opened ones to keep remembering.
    /// Each box once; nothing while the owner is away or hands off is on; one screen a minute;
    /// a box the other Mac no longer reports is forgotten.
    public static func bringNow(needs: [String], opened: Set<String>, ownerHere: Bool, held: Bool,
                                            lastOpen: Date, now: Date) -> (act: [String], keep: Set<String>) {
        let keep = opened.intersection(needs)
        guard ownerHere, !held, now.timeIntervalSince(lastOpen) >= bringGap else { return ([], keep) }
        var fresh: [String] = []
        for id in needs where !id.isEmpty && !keep.contains(id) && !fresh.contains(id) { fresh.append(id) }
        return (fresh, keep)
    }

    /// The line the owner reads when a screen was brought to them.
    public static func bringLine(peer: String, says: String, opened: Bool) -> String {
        var s = says.trimmingCharacters(in: .whitespacesAndNewlines)
        while let c = s.last, ".!?:;, ".contains(c) { s.removeLast() }
        if s.isEmpty { s = "a box with no words I could read" }
        return "\(peer) needs a press only you can make: \(s). " + (opened ? "I have opened its screen for you." : "I could not open its screen, so please go to it.")
    }

    /// The link that opens another Mac's screen. Nil unless the address is a plain one.
    public nonisolated static func screenLink(_ address: String) -> URL? {
        let a = address.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty, a.count <= 100, a.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".-:".contains($0)) }),
              a.first!.isLetter || a.first!.isNumber || a.first! == ":" else { return nil }
        return URL(string: "vnc://" + (a.contains(":") ? "[\(a)]" : a))
    }
    public nonisolated static func openScreenFor(_ address: String) -> Bool {
        guard let u = screenLink(address) else { return false }
        return NSWorkspace.shared.open(u)
    }

    /// True when the keys or the mouse of this Mac were touched this recently.
    public nonisolated static func here(idle: TimeInterval) -> Bool { idle >= 0 && idle < 60 }
    public nonisolated static func ownerAtThisMac() -> Bool {
        here(idle: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!))
    }

    /// Another Mac answered a check. `needs` is what its beat carried; `at` is the address that answered.
    /// Returns the lines written down.
    @discardableResult
    func bring(name: String, at address: String, needs raw: Any?, now: Date) -> [String] {
        var says: [String: String] = [:], ids: [String] = []
        for n in ((raw as? [[String: Any]]) ?? []).prefix(8) {
            guard let id = n["id"] as? String, !id.isEmpty, id.count <= 120, says[id] == nil else { continue }
            ids.append(id); says[id] = String((n["says"] as? String ?? "").prefix(200))
        }
        let d = Door.bringNow(needs: ids, opened: broughtIds[name] ?? [], ownerHere: ids.isEmpty ? false : ownerHere(),
                              held: held, lastOpen: broughtAt, now: now)
        broughtIds[name] = d.keep.isEmpty ? nil : d.keep
        guard !d.act.isEmpty else { return [] }
        broughtAt = now
        let ok = openScreen(address)
        broughtIds[name] = d.keep.union(d.act)
        var lines: [String] = []
        for (i, id) in d.act.enumerated() {
            let said = Door.bringLine(peer: name, says: says[id] ?? "", opened: ok)
            var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-bring-\(slug(name))-\(i + 1)", do: "notice"); ask.app = name
            record(ask, DoorAnswer(id: ask.id, ok: ok, said: said, front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            onAct?(said); lines.append(said)
        }
        onDone?()
        return lines
    }
}
