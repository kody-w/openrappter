import Foundation

/// One week of the door's own record, as plain counts.
public struct DoorWeek: Equatable {
    public struct Reason: Equatable {
        public var why: String, times: Int
        public init(why: String, times: Int) { self.why = why; self.times = times }
    }
    public var answered = 0   // boxes answered by a standing answer
    public var chores = 0     // jobs run on a clock or a sight
    public var covered = 0    // jobs run because another Mac was quiet
    public var asked = 0      // jobs done because someone asked
    public var noticed = 0    // boxes noticed waiting
    public var restarts = 0   // restarts tidied up after
    public var quiet = 0      // times another Mac went quiet
    public var failed = 0     // things it tried and could not do
    public var reasons: [Reason] = []   // the three most common reasons, most common first
    public var presses = 0    // an estimate of presses the owner did not have to make
    public init() {}
    /// Every job that ran, however it was started.
    public var ran: Int { chores + covered + asked }
    public var isEmpty: Bool { answered + ran + noticed + restarts + quiet + failed == 0 }
}

/// A weekly note of what the door saved the owner: one short page, written by itself each Monday morning.
extension Door {
    // MARK: counting

    /// Counts the last seven days of the record. Pure, so it can be checked without a screen or a clock.
    public nonisolated static func week(lines: [[String: Any]], now: Date, calendar: Calendar = .current) -> DoorWeek {
        let from = (calendar.date(byAdding: .day, value: -7, to: now) ?? now.addingTimeInterval(-7 * 86400)).timeIntervalSince1970
        let to = now.timeIntervalSince1970
        var w = DoorWeek()
        var why: [String: Int] = [:]
        let acting = ["pressing", "clicking", "typing", "opening", "doing the job"]
        for l in lines {
            guard let at = l["at"] as? Double, at >= from, at <= to else { continue }
            let id = l["id"] as? String ?? "", did = l["did"] as? String ?? "", said = l["said"] as? String ?? ""
            let ok = l["ok"] as? Bool ?? false
            if id.hasPrefix("notice-") {
                if said.contains("as you always do") { w.answered += 1 }
                else if said.hasPrefix("a box from ") { w.noticed += 1 }
                else if said.hasPrefix("this Mac restarted") { w.restarts += 1 }
                else if said.contains(" has gone quiet") { w.quiet += 1 }
                continue
            }
            guard acting.contains(where: { did.hasPrefix($0) }) else { continue }
            guard ok else { w.failed += 1; why[weekReason(said), default: 0] += 1; continue }
            guard did.hasPrefix("doing the job") else { continue }
            if id.hasPrefix("watch-") { w.chores += 1 } else if id.hasPrefix("cover-") { w.covered += 1 } else { w.asked += 1 }
            w.presses += weekSteps(said)
        }
        w.presses += w.answered
        w.reasons = why.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(3)
            .map { DoorWeek.Reason(why: $0.key, times: $0.value) }
        return w
    }

    /// How many steps a finished job says it did: the N in "N steps done".
    public nonisolated static func weekSteps(_ said: String) -> Int {
        guard let re = try? NSRegularExpression(pattern: "(\\d+) steps done"),
              let m = re.firstMatch(in: said, range: NSRange(said.startIndex..., in: said)),
              let r = Range(m.range(at: 1), in: said) else { return 0 }
        return Int(said[r]) ?? 0
    }

    /// The plain reason inside what was said when something did not work, so the same trouble groups together.
    public nonisolated static func weekReason(_ said: String) -> String {
        var s = said
        for mark in [" stopped at step ", " stopped before step "] {
            if let m = s.range(of: mark), let colon = s.range(of: ": ", range: m.upperBound..<s.endIndex) { s = String(s[colon.upperBound...]); break }
        }
        s = s.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("hands off") { return "Hands off was on" }
        if s.isEmpty { return "No reason was given" }
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    // MARK: the words

    nonisolated static func weekMany(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

    /// The one big sentence at the top of the note.
    public nonisolated static func weekSentence(_ w: DoorWeek) -> String {
        if w.isEmpty { return "A quiet week. Nothing needed doing." }
        var parts: [String] = []
        if w.answered > 0 { parts.append("answered \(weekMany(w.answered, "box", "boxes"))") }
        if w.ran > 0 { parts.append("ran \(weekMany(w.ran, "chore", "chores"))") }
        if parts.isEmpty {
            return w.failed > 0 ? "I did not get anything done for you this week. What got in the way is below."
                                : "I kept watch this week. Nothing needed doing by me."
        }
        let saved = w.presses > 0 ? ", about \(weekMany(w.presses, "press", "presses")) you did not have to make" : ""
        return "I \(parts.joined(separator: " and ")) for you this week\(saved)."
    }

    /// The one line about what is waiting for the owner now.
    public nonisolated static func weekWaiting(_ n: Int) -> String {
        n <= 0 ? "Nothing is waiting on you now." : (n == 1 ? "1 thing is waiting on you now." : "\(n) things are waiting on you now.")
    }

    /// The short list of counts, in order, without the ones that are zero.
    public nonisolated static func weekRows(_ w: DoorWeek) -> [(says: String, count: Int)] {
        [("Boxes I answered the way you always do", w.answered),
         ("Chores I ran on time or when I saw the sign", w.chores),
         ("Jobs I ran while another Mac was quiet", w.covered),
         ("Jobs I did when asked", w.asked),
         ("Boxes I noticed waiting", w.noticed),
         ("Restarts I tidied up after", w.restarts),
         ("Times another Mac went quiet", w.quiet)].filter { $0.1 > 0 }.map { (says: $0.0, count: $0.1) }
    }

    /// The whole note as a page, in the same look as the main page.
    public nonisolated static func weekPage(_ w: DoorWeek, host: String, waiting: Int) -> String {
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        var body = ""
        let rows = weekRows(w)
        if !rows.isEmpty {
            body += "<h2>The week in numbers</h2><ul>" + rows.map { "<li><b>\(esc($0.says))</b><span>\($0.count)</span></li>" }.joined() + "</ul>"
        }
        if !w.isEmpty {
            body += "<h2>What I could not do <em>\(w.failed)</em></h2>"
            if w.failed == 0 { body += "<p>Nothing. Everything I tried worked.</p>" }
            else {
                body += "<ul>" + w.reasons.map { "<li><b>\(esc($0.why))</b><span>\($0.times == 1 ? "once" : "\($0.times) times")</span></li>" }.joined() + "</ul>"
                let rest = w.failed - w.reasons.reduce(0) { $0 + $1.times }
                if rest > 0 { body += "<p>And \(rest) more for other reasons.</p>" }
            }
        }
        return """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>This week</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:34px;margin:0}h2{font-size:20px;margin:34px 0 8px;color:#f0a04b}h2 em{font-style:normal;opacity:.6}
        ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #2c2622}
        li b{font-weight:500}li span{opacity:.55;white-space:nowrap}p{opacity:.6}a{color:#f0a04b}
        .sub{opacity:.6;margin:4px 0 0}.big{opacity:1;font-size:26px;line-height:1.35;margin:26px 0 0}</style>
        <p><a href="page.html" onclick="history.back();return false">Back</a></p>
        <h1>This week</h1><p class="sub">\(esc(host)), the last 7 days</p>
        <p class="big">\(esc(weekSentence(w)))</p>
        \(body)
        <h2>Waiting on you</h2><p>\(weekWaiting(waiting))</p>
        """
    }

    // MARK: writing it

    var weekURL: URL { dir.appendingPathComponent("weekly.html") }
    var weekSeenURL: URL { dir.appendingPathComponent("week.json") }

    /// Writes the note from the record as it stands, and gives back the big sentence.
    @discardableResult
    public func writeWeek(now: Date = Date(), calendar: Calendar = .current) -> (ok: Bool, said: String) {
        let lines = ((try? String(contentsOf: dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").split(separator: "\n")
            .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        let w = Door.week(lines: lines, now: now, calendar: calendar)
        let left = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("left.json")))) as? [String: Any])?["left"] as? [Any]
        let html = Door.weekPage(w, host: Host.current().localizedName ?? "this Mac", waiting: left?.count ?? 0)
        let ok = (try? Data(html.utf8).write(to: weekURL, options: .atomic)) != nil
        return (ok, ok ? Door.weekSentence(w) : "I could not write your weekly note")
    }

    /// True when this week's note is owed: Monday 08:00 has passed and nothing was written since this week began.
    /// A Mac asleep on Monday morning writes it when it next wakes that week (the same idea as the daily watches).
    public nonisolated static func weekDue(now: Date, last: Double?, calendar: Calendar = .current) -> Bool {
        let back = (calendar.component(.weekday, from: now) + 5) % 7   // days since Monday
        guard let monday = calendar.date(byAdding: .day, value: -back, to: calendar.startOfDay(for: now)),
              let eight = calendar.date(bySettingHour: 8, minute: 0, second: 0, of: monday) else { return false }
        return now >= eight && (last ?? 0) < monday.timeIntervalSince1970
    }

    /// Called on every heartbeat. Writes the note once a week with a line saying so, and keeps the page fresh in between.
    func keepWeek(now: Date, calendar: Calendar = .current) {
        let last = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: weekSeenURL))) as? [String: Any])?["wrote"] as? Double
        // The very first time: start counting from now, so the first note comes on the next Monday morning, not at once.
        if last == nil, let d = try? JSONSerialization.data(withJSONObject: ["wrote": now.timeIntervalSince1970]) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if (try? d.write(to: weekSeenURL, options: .atomic)) != nil {
                let age = (try? FileManager.default.attributesOfItem(atPath: weekURL.path)[.modificationDate] as? Date).map { now.timeIntervalSince($0) } ?? .infinity
                if age > 3600 { writeWeek(now: now, calendar: calendar) }
                return
            }
        }
        if Door.weekDue(now: now, last: last, calendar: calendar) {
            guard writeWeek(now: now, calendar: calendar).ok else { return }
            if let d = try? JSONSerialization.data(withJSONObject: ["wrote": now.timeIntervalSince1970]) { try? d.write(to: weekSeenURL, options: .atomic) }
            let ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-week", do: "notice")
            record(ask, DoorAnswer(id: ask.id, ok: true, said: "Your weekly note is ready.", front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            onAct?("your weekly note is ready"); onDone?()
            return
        }
        let age = (try? FileManager.default.attributesOfItem(atPath: weekURL.path)[.modificationDate] as? Date).map { now.timeIntervalSince($0) } ?? .infinity
        if age > 3600 { writeWeek(now: now, calendar: calendar) }
    }
}
