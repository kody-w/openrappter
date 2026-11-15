import AppKit
import ApplicationServices
import Speech

/// A standing order: run a learned job on a sight, at a time of day, or every so many minutes.
public struct DoorWatch: Codable, Equatable {
    public var title: String
    public var job: String
    public var see: String?
    public var app: String?
    public var at: String?
    public var every: Double?
    public var cover: Bool?      // the owner's other Macs run this one when this Mac goes quiet
    public var on: [Int]?        // with `at`: only on these days, 1 = Sunday ... 7 = Saturday; nil = every day
}

/// The rest of the door: hands off, standing orders, noticing a waiting box, the page of what happened,
/// packing jobs for another Mac, and learning a job by watching the owner do it.
extension Door {
    // MARK: hands off

    var holdURL: URL { dir.appendingPathComponent("hold") }
    /// True while the owner has said hands off. A plain file, so anything can set it: `touch ~/.openrappter/door/hold`.
    public var held: Bool { FileManager.default.fileExists(atPath: holdURL.path) }

    public func hold() { FileManager.default.createFile(atPath: holdURL.path, contents: Data()) }
    public func release() { try? FileManager.default.removeItem(at: holdURL) }
    /// What the owner said out loud, if it was about the hands: "hold", "resume", or nil.
    public static func spoken(_ heard: String) -> String? {
        let w = heard.lowercased().filter { $0.isLetter || $0 == " " }.split(separator: " ").joined(separator: " ")
        let said = w.replacingOccurrences(of: "rappter ", with: "").replacingOccurrences(of: "raptor ", with: "").replacingOccurrences(of: "rapper ", with: "")
        if ["hands off", "hand off", "stop", "stop everything", "hold"].contains(said) { return "hold" }
        if ["hands on", "hands back on", "carry on", "resume"].contains(said) { return "resume" }
        return nil
    }

    /// A button on the page was clicked. Only an offer the current page made, with its one-time token, is taken.
    public func clicked(_ url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard url.scheme == "openrappter", url.host == "pick", parts.count == 2, take(token: parts[0], key: parts[1]) else { return }
        Task { await self.settle() }
    }

    /// Takes one offer the current page made. The token is used up, so the same click cannot land twice.
    func take(token: String, key: String) -> Bool {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("offers.json")),
              let all = try? JSONDecoder().decode([String: [DoorAsk]].self, from: data),
              all["token"]?.first?.id == token, var ask = all["offers"]?.first(where: { $0.id == key }) else { return false }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("offers.json"))
        ask.id = "pick-\(Int(Date().timeIntervalSince1970))-\(key)"
        guard let d = try? JSONEncoder().encode(ask) else { return false }
        return (try? d.write(to: dir.appendingPathComponent("\(ask.id).json"), options: .atomic)) != nil
    }

    func settle() async {
        await drain()
        try? await Task.sleep(for: .seconds(1))
        noticeBoxes(Screen.boxes(), now: Date())
        _ = writePage(hours: 24)
    }

    /// An answer picked from anywhere: the page on this Mac, or the owner's phone over the private network.
    public func pick(token: String, key: String) async -> Bool {
        guard take(token: token, key: key) else { return false }
        await settle()
        return true
    }

    var questionsDir: URL { dir.appendingPathComponent("questions") }
    /// The answer to a question, once the owner has picked. Nil while it is still open.
    public func answered(_ id: String) -> [String: Any]? {
        guard let d = try? Data(contentsOf: questionsDir.appendingPathComponent("\(id).answer.json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    }

    var watchesDir: URL { dir.appendingPathComponent("watches") }
    var firedURL: URL { watchesDir.appendingPathComponent(".fired.json") }
    var waitingURL: URL { dir.appendingPathComponent("waiting.json") }

    public func watches() -> [DoorWatch] {
        ((try? FileManager.default.contentsOfDirectory(at: watchesDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" && !$0.lastPathComponent.hasPrefix(".") }
            .compactMap { try? JSONDecoder().decode(DoorWatch.self, from: Data(contentsOf: $0)) }
            .sorted { $0.title < $1.title }
    }

    func slug(_ name: String) -> String {
        name.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined().split(separator: "-").joined(separator: "-")
    }

    func more(_ a: DoorAsk, _ ans: inout DoorAnswer) async -> Bool {
        let fm = FileManager.default
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        switch a.do {
        case "question":
            // Anything on this Mac can put a question to the owner. It shows on the page with a button per choice.
            guard let title = a.title, let ch = a.choices, !ch.isEmpty, !a.id.isEmpty else { ans.said = "a question needs words and choices"; return true }
            try? fm.createDirectory(at: questionsDir, withIntermediateDirectories: true)
            let q: [String: Any] = ["id": a.id, "title": title, "text": a.text ?? "", "choices": ch, "at": Date().timeIntervalSince1970]
            ans.ok = (try? JSONSerialization.data(withJSONObject: q, options: [.sortedKeys]).write(to: questionsDir.appendingPathComponent("\(a.id).json"), options: .atomic)) != nil
            ans.said = ans.ok ? "asked you: \(title)" : "could not keep the question"
        case "answer":
            guard let qid = a.text, let picked = a.title, fm.fileExists(atPath: questionsDir.appendingPathComponent("\(qid).json").path) else { ans.said = "that question is not open"; return true }
            let r: [String: Any] = ["id": qid, "picked": picked, "at": Date().timeIntervalSince1970]
            ans.ok = (try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]).write(to: questionsDir.appendingPathComponent("\(qid).answer.json"), options: .atomic)) != nil
            try? fm.removeItem(at: questionsDir.appendingPathComponent("\(qid).json"))
            ans.said = "you picked \(picked)"
        case "forget":
            guard let id = a.text else { ans.said = "forget needs what to leave"; return true }
            let u = dir.appendingPathComponent("forgotten.json")
            var list = (try? JSONDecoder().decode([String].self, from: Data(contentsOf: u))) ?? []
            list.append(id); ans.ok = (try? JSONEncoder().encode(Array(list.suffix(200))).write(to: u, options: .atomic)) != nil
            ans.said = "left it"
        case "always":
            guard let app = a.app, let name = a.title else { ans.said = "always needs the app and the button"; return true }
            var rules = alwaysRules()
            let says = a.text ?? ""
            rules.removeAll { $0.app == app && $0.says == says }
            if a.key == "off" {
                ans.ok = saveAlways(rules); ans.said = "I will ask you again when \(app) asks that"
            } else if Door.gates.contains(app) {
                ans.said = "that box guards this Mac, so I always ask you"
            } else {
                rules.append(DoorAlways(app: app, says: says, buttons: (a.steps ?? []).compactMap { $0.title }.sorted(), press: name, since: Date().timeIntervalSince1970))
                ans.ok = saveAlways(rules); ans.said = "from now on I press \(name) when \(app) asks that"
                var p = DoorAsk(id: "always-\(Int(Date().timeIntervalSince1970))-now", do: "press"); p.title = name; p.app = app
                if let d = try? JSONEncoder().encode(p) { try? d.write(to: dir.appendingPathComponent("\(p.id).json"), options: .atomic) }
            }
        case "hold":
            ans.ok = fm.createFile(atPath: holdURL.path, contents: Data())
            ans.said = "hands off. I will look but not touch until you ask resume."
        case "resume":
            try? fm.removeItem(at: holdURL); ans.ok = !held; ans.said = "hands back on"
        case "watch":
            guard let title = a.title, let job = a.job, let url = learnedURL(job), fm.fileExists(atPath: url.path) else {
                ans.said = "watch needs a name and a job I have learned"; return true }
            guard a.see != nil || a.at != nil || a.every != nil else { ans.said = "watch needs a sight, a time or an every"; return true }
            if let at = a.at, Door.minutes(at) == nil { ans.said = "I could not read the time \(at); say it like 07:30"; return true }
            try? fm.createDirectory(at: watchesDir, withIntermediateDirectories: true)
            let w = DoorWatch(title: title, job: job, see: a.see, app: a.app, at: a.at, every: a.every,
                              cover: (a.with ?? []).contains("cover") && a.see == nil ? true : nil, on: nil)
            ans.ok = (try? enc.encode(w).write(to: watchesDir.appendingPathComponent("\(slug(title)).json"), options: .atomic)) != nil
            ans.said = ans.ok ? "watching: \(Door.plain(w))" : "could not keep that watch"
        case "unwatch":
            guard let title = a.title else { ans.said = "unwatch needs a name"; return true }
            let url = watchesDir.appendingPathComponent("\(slug(title)).json")
            ans.ok = fm.fileExists(atPath: url.path); try? fm.removeItem(at: url)
            ans.said = ans.ok ? "no longer watching \(title)" : "I was not watching \(title)"
        case "hear":
            // A rehearsal with no person and no microphone: speak the words to a sound file, listen to the file
            // with the same recogniser the ears use, and act on what was heard.
            guard let t = a.text, !t.isEmpty else { ans.said = "hear needs the words to say"; return true }
            let file = dir.appendingPathComponent("\(a.id).aiff")
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/say"); p.arguments = ["-o", file.path, t]
            guard (try? p.run()) != nil else { ans.said = "could not make the sound"; return true }
            p.waitUntilExit()
            guard SFSpeechRecognizer.authorizationStatus() == .authorized,
                  let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else { ans.said = "not allowed to understand speech yet"; return true }
            let req = SFSpeechURLRecognitionRequest(url: file); req.shouldReportPartialResults = false
            let heard: String = await withCheckedContinuation { c in
                var done = false
                rec.recognitionTask(with: req) { r, e in
                    guard !done else { return }
                    if let r, r.isFinal { done = true; c.resume(returning: r.bestTranscription.formattedString) }
                    else if e != nil { done = true; c.resume(returning: "") }
                }
            }
            try? fm.removeItem(at: file)
            let word = Door.spoken(heard)
            if word == "hold" { hold() } else if word == "resume" { release() }
            ans.ok = !heard.isEmpty
            ans.said = heard.isEmpty ? "I heard nothing" : "I heard \"\(heard)\"" + (word == "hold" ? ", so hands off is on" : word == "resume" ? ", so hands are back on" : ", which is not about the hands")
        case "boxes":
            if a.text == "windows" { ans.ok = true; ans.words = Screen.windowFacts(); ans.said = "windows listed"; return true }
            let b = Screen.boxes(); ans.ok = true
            ans.words = b.map { "\($0.app): " + $0.words.prefix(6).joined(separator: "; ") }
            ans.said = b.isEmpty ? "nothing is waiting for an answer" : "\(b.count) waiting for an answer"
        case "watches":
            let all = watches(); ans.ok = true; ans.words = all.map { Door.plain($0) }; ans.said = "I keep \(all.count) watches"
        case "page":
            let r = writePage(hours: a.every ?? 24)
            ans.ok = r.ok; ans.said = r.said; ans.picture = nil
        case "pack":
            let out = dir.appendingPathComponent("pack"); try? fm.removeItem(at: out)
            try? fm.createDirectory(at: out, withIntermediateDirectories: true)
            let stamp = Int(Date().timeIntervalSince1970)
            var n = 0
            for f in ((try? fm.contentsOfDirectory(at: learned, includingPropertiesForKeys: nil)) ?? [])
            where f.pathExtension == "json" && !f.lastPathComponent.hasPrefix(".") {
                guard let steps = try? JSONDecoder().decode([DoorAsk].self, from: Data(contentsOf: f)) else { continue }
                let name = f.deletingPathExtension().lastPathComponent
                var ask = DoorAsk(id: "pack-\(stamp)-1-\(name)", do: "learn")
                ask.title = name.replacingOccurrences(of: "-", with: " "); ask.steps = steps
                if (try? enc.encode(ask).write(to: out.appendingPathComponent("\(ask.id).json"))) != nil { n += 1 }
            }
            var m = 0
            for w in watches() {
                var ask = DoorAsk(id: "pack-\(stamp)-2-\(slug(w.title))", do: "watch")
                ask.title = w.title; ask.job = w.job; ask.see = w.see; ask.app = w.app; ask.at = w.at; ask.every = w.every
                if (try? enc.encode(ask).write(to: out.appendingPathComponent("\(ask.id).json"))) != nil { m += 1 }
            }
            ans.ok = n + m > 0
            ans.said = ans.ok ? "packed \(n) jobs and \(m) watches. Copy the pack folder into another Mac's door and it learns them." : "nothing to pack yet"
        case "chore":
            // One plain sentence: what to do and when. The owner shows it once; saying yes keeps the job and its clock together.
            guard let said = a.text, let c = Door.chore(said) else { ans.said = "say what to do and when, like: every Friday at 9, export last week's orders"; return true }
            guard AXIsProcessTrusted() else { ans.said = "not allowed to watch yet"; return true }
            let w = DoorWatch(title: c.title, job: c.title, see: nil, app: nil, at: c.at, every: c.every, cover: nil, on: c.on)
            _ = try? enc.encode(w).write(to: dir.appendingPathComponent(".chore.json"), options: .atomic)
            startShowing(c.title); ans.ok = showMonitor != nil
            let when = String(Door.plain(w).drop(while: { $0 != "\"" }).dropFirst().drop(while: { $0 != "\"" }).dropFirst(2))
            ans.said = ans.ok ? "I will \(c.title) \(when). Show me once now, then ask shown, then yes." : "this Mac would not let me watch"
        case "show":
            guard let title = a.title, !slug(title).isEmpty else { ans.said = "show needs a name for the job"; return true }
            guard AXIsProcessTrusted() else { ans.said = "not allowed to watch yet"; return true }
            startShowing(title); ans.ok = showMonitor != nil
            ans.said = ans.ok ? "watching. Do the job once, then ask shown." : "this Mac would not let me watch"
        case "shown":
            guard showMonitor != nil else { ans.said = "I was not watching"; return true }
            stopShowing()
            guard !shownSteps.isEmpty, let url = learnedURL(shownName) else { ans.said = "I did not see any steps (\(shownMice) presses, \(shownKeys) keys)"; return true }
            let draft = url.deletingLastPathComponent().appendingPathComponent(".draft-" + url.lastPathComponent)
            ans.ok = (try? enc.encode(shownSteps).write(to: draft, options: .atomic)) != nil
            ans.words = shownSteps.enumerated().map { "\($0.offset + 1). \(Door.line($0.element))" }
            ans.said = "I watched \(shownSteps.count) steps for \(shownName) (\(shownMice) presses, \(shownKeys) keys). Ask yes to keep it."
        case "yes":
            guard let title = a.title ?? (shownName.isEmpty ? nil : shownName), let url = learnedURL(title) else { ans.said = "yes needs the job name"; return true }
            let draft = url.deletingLastPathComponent().appendingPathComponent(".draft-" + url.lastPathComponent)
            guard fm.fileExists(atPath: draft.path) else { ans.said = "nothing shown is waiting under \(title)"; return true }
            try? fm.removeItem(at: url)
            ans.ok = (try? fm.moveItem(at: draft, to: url)) != nil
            ans.said = ans.ok ? "learned \(title)" : "could not keep \(title)"
            let pending = dir.appendingPathComponent(".chore.json")
            if ans.ok, let w = try? JSONDecoder().decode(DoorWatch.self, from: Data(contentsOf: pending)), slug(w.job) == slug(title) {
                try? fm.createDirectory(at: watchesDir, withIntermediateDirectories: true)
                if (try? enc.encode(w).write(to: watchesDir.appendingPathComponent("\(slug(w.title)).json"), options: .atomic)) != nil {
                    ans.said = "learned \(title). " + Door.plain(w).replacingOccurrences(of: "\(w.title): do \"\(w.job)\"", with: "I will do it")
                }
                try? fm.removeItem(at: pending)
            }
        default:
            return false
        }
        return true
    }

    static func minutes(_ at: String) -> Int? {
        let p = at.split(separator: ":").compactMap { Int($0) }
        guard p.count == 2, (0..<24).contains(p[0]), (0..<60).contains(p[1]) else { return nil }
        return p[0] * 60 + p[1]
    }

    public static func plain(_ w: DoorWatch) -> String {
        var when: [String] = []
        if let s = w.see { when.append("when the screen says \"\(s)\"") }
        if let t = w.at { when.append("\(Door.days(w.on)) at \(t)") }
        if let e = w.every { when.append("every \(Int(e)) minutes") }
        return "\(w.title): do \"\(w.job)\" \(when.joined(separator: " and "))"
    }

    // MARK: the clock, the sights and the waiting box

    /// Which watches are due. Pure, so it can be checked without a screen.
    /// A daily time missed while the Mac slept still runs later the same day (the anacron lesson).
    public static func due(_ all: [DoorWatch], now: Date, fired: [String: Double], onScreen: [String], lit: Set<String>,
                           calendar: Calendar = .current) -> [DoorWatch] {
        all.filter { w in
            let last = fired[w.title].map { Date(timeIntervalSince1970: $0) }
            if let s = w.see {
                return onScreen.contains { $0.localizedCaseInsensitiveContains(s) } && !lit.contains(w.title)
            }
            if let at = w.at, let m = minutes(at) {
                let c = calendar.dateComponents([.hour, .minute], from: now)
                let nowM = (c.hour ?? 0) * 60 + (c.minute ?? 0)
                if let on = w.on, !on.contains(calendar.component(.weekday, from: now)) { return false }
                return nowM >= m && !(last.map { calendar.isDate($0, inSameDayAs: now) } ?? false)
            }
            if let e = w.every, e > 0 { return last.map { now.timeIntervalSince($0) >= e * 60 } ?? true }
            return false
        }
    }

    public func tick(now: Date = Date()) async {
        guard !busy else { return }
        let boxes = Screen.boxes()
        noticeBoxes(boxes, now: now)
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        keepPlace(now: now, bootedAt: Date(timeIntervalSinceNow: -ProcessInfo.processInfo.systemUptime),
                  running: apps.compactMap { a in a.bundleURL.map { (a.localizedName ?? $0.lastPathComponent, $0.path) } },
                  os: ProcessInfo.processInfo.operatingSystemVersionString) { NSWorkspace.shared.open(URL(fileURLWithPath: $0)) }
        checkUpdates(now: now)
        if now.timeIntervalSince(peersLooked) >= 60 {
            peersLooked = now
            for p in peers() {
                Task { @MainActor in
                    var heard: [[String: Any]]? = nil
                    for host in [p.at, p.lan].compactMap({ $0 }) where heard == nil {
                        guard let u = URL(string: "http://\(host):\(DoorWeb.port)/beat") else { continue }
                        var req = URLRequest(url: u); req.timeoutInterval = 3
                        do {
                            let (d, _) = try await URLSession.shared.data(for: req)
                            if let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], o["mac"] != nil { heard = (o["cover"] as? [[String: Any]]) ?? []; self.bring(name: p.name, at: host, needs: o["needs"], now: Date()) }
                        } catch { try? Data("\(Date()) \(host): \(error.localizedDescription) \((error as NSError).code)\n".utf8).write(to: self.dir.appendingPathComponent("peer-error.txt")) }
                    }
                    // Report in as well: a Mac that cannot be reached may still be able to reach out.
                    let me = try? JSONSerialization.data(withJSONObject: ["mac": Host.current().localizedName ?? "this Mac"])
                    for host in [p.at, p.lan].compactMap({ $0 }) {
                        guard let u = URL(string: "http://\(host):\(DoorWeb.port)/beat") else { continue }
                        var req = URLRequest(url: u); req.timeoutInterval = 3; req.httpMethod = "POST"; req.httpBody = me
                        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                        if let (_, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200 { break }
                    }
                    for w in self.peerBeat(name: p.name, heard: heard, now: Date()) {
                        var ask = DoorAsk(id: "cover-\(Int(Date().timeIntervalSince1970))-\(self.slug(w.title))", do: "job"); ask.title = w.job
                        if let d = try? JSONEncoder().encode(ask) { try? d.write(to: self.dir.appendingPathComponent("\(ask.id).json"), options: .atomic) }
                    }
                }
            }
        }
        if now.timeIntervalSince(signLooked) >= 300 {
            signLooked = now
            noticeSignOuts(apps.compactMap(\.localizedName).filter { !Door.browsers.contains($0) }.map { ($0, Screen.words(app: $0)) }, now: now)
        }
        // The page keeps itself fresh, so it is there in the morning with no one asking.
        let page = dir.appendingPathComponent("page.html")
        let age = (try? FileManager.default.attributesOfItem(atPath: page.path)[.modificationDate] as? Date).map { now.timeIntervalSince($0) } ?? .infinity
        if age > 3600 { _ = writePage(hours: 24, now: now) }
        let all = watches()
        guard !all.isEmpty, !held else { return }
        var fired = (try? JSONDecoder().decode([String: Double].self, from: Data(contentsOf: firedURL))) ?? [:]
        var screenFor: [String: [String]] = [:]
        func screen(_ app: String?) -> [String] {
            let k = app ?? ""
            if let s = screenFor[k] { return s }
            let s = Screen.words(app: app) + (app == nil ? boxes.flatMap { $0.words } : [])
            screenFor[k] = s; return s
        }
        for w in all where w.see != nil {
            if !screen(w.app).contains(where: { $0.localizedCaseInsensitiveContains(w.see!) }) { lit.remove(w.title) }
        }
        busy = true; defer { busy = false }
        for w in all {
            guard !Door.due([w], now: now, fired: fired, onScreen: screen(w.app), lit: lit).isEmpty else { continue }
            if w.see != nil { lit.insert(w.title) }
            fired[w.title] = now.timeIntervalSince1970
            try? JSONEncoder().encode(fired).write(to: firedURL, options: .atomic)
            var ask = DoorAsk(id: "watch-\(Int(now.timeIntervalSince1970))-\(slug(w.title))", do: "job"); ask.title = w.job
            onAct?("\(w.title): \(Door.line(ask))")
            let answer = await carryOut(ask)
            write(answer); record(ask, answer); onDone?()
        }
    }

    /// A box that sits on screen past its patience gets written down and said, once.
    func noticeBoxes(_ boxes: [(app: String, words: [String])], now: Date) {
        var live: Set<String> = []
        var waitingNow: [[String: Any]] = []
        for b in boxes {
            let key = b.app + "|" + b.words.filter { $0.hasPrefix("Button") }.sorted().joined(separator: "|")
            live.insert(key)
            let since = boxSince[key] ?? now
            boxSince[key] = since
            // A standing answer: the owner said "always answer it this way" for exactly this box.
            if !held, now.timeIntervalSince(since) >= 10, !boxTold.contains(key),
               let rule = alwaysRules().first(where: { $0.app == b.app && $0.says == Door.boxSays(b.words) && $0.buttons == Door.boxButtons(b.words).sorted() }) {
                let recent = (alwaysFired[key] ?? []).filter { now.timeIntervalSince($0) < 600 }
                if recent.count < 3 {
                    alwaysFired[key] = recent + [now]
                    var p = DoorAsk(id: "always-\(Int(now.timeIntervalSince1970))-\(live.count)", do: "press"); p.title = rule.press; p.app = b.app
                    if let d = try? JSONEncoder().encode(p) { try? d.write(to: dir.appendingPathComponent("\(p.id).json"), options: .atomic) }
                    var note = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-always\(live.count)", do: "notice"); note.app = b.app
                    record(note, DoorAnswer(id: note.id, ok: true, said: "\(b.app) asked \"\(rule.says)\" and I pressed \(rule.press), as you always do", front: nil, words: b.words, picture: nil, at: now.timeIntervalSince1970))
                    boxSince[key] = nil
                    continue
                }
            }
            guard now.timeIntervalSince(since) >= boxPatience else { continue }
            var entry: [String: Any] = ["app": b.app, "since": since.timeIntervalSince1970, "words": b.words]
            if let why = boxCause[key] ?? Door.cause(since: since, bootedAt: Date(timeIntervalSinceNow: -ProcessInfo.processInfo.systemUptime),
                                                     appOpened: NSWorkspace.shared.runningApplications.first { $0.localizedName == b.app }?.launchDate,
                                                     app: b.app, last: lastActed(before: since)) {
                boxCause[key] = why; entry["cause"] = why
            }
            waitingNow.append(entry)
            if !boxTold.contains(key) {
                boxTold.insert(key)
                var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))", do: "notice"); ask.app = b.app
                let said = "a box from \(b.app) has been waiting \(Int(now.timeIntervalSince(since) / 60)) min: " + b.words.prefix(6).joined(separator: "; ")
                record(ask, DoorAnswer(id: ask.id, ok: true, said: said, front: nil, words: b.words, picture: nil, at: now.timeIntervalSince1970))
                onAct?("something is waiting for an answer"); onDone?()
            }
        }
        boxSince = boxSince.filter { live.contains($0.key) }
        boxTold = boxTold.intersection(live)
        boxCause = boxCause.filter { live.contains($0.key) }
        if waitingNow.isEmpty { try? FileManager.default.removeItem(at: waitingURL) }
        else if let d = try? JSONSerialization.data(withJSONObject: waitingNow, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: waitingURL, options: .atomic) }
    }

    // MARK: the page of what happened

    func writePage(hours: Double, now: Date = Date()) -> (ok: Bool, said: String) {
        let cutoff = now.timeIntervalSince1970 - hours * 3600
        let lines = ((try? String(contentsOf: dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "").split(separator: "\n")
            .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            .filter { ($0["at"] as? Double ?? 0) >= cutoff }
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        func row(_ l: [String: Any]) -> String {
            let t = f.string(from: Date(timeIntervalSince1970: l["at"] as? Double ?? 0))
            let proof = (l["proof"] as? String).flatMap { FileManager.default.fileExists(atPath: self.dir.appendingPathComponent("proof/\($0).html").path) ? $0 : nil }
            return "<li><b>\(esc(l["said"] as? String ?? ""))</b><span>\(proof.map { "<a href=\"proof/\($0).html\">before and after</a> " } ?? "")\(t)</span></li>"
        }
        let quiet = ["looking at the screen", "listing the jobs I know", "listing what I watch for", "writing the page of what happened"]
        let noticed = lines.filter { ($0["id"] as? String ?? "").hasPrefix("notice-") }
        // Everything with a before-and-after picture, newest first, single presses included.
        let proofs = Array(lines.filter { l in (l["proof"] as? String).map { FileManager.default.fileExists(atPath: self.dir.appendingPathComponent("proof/\($0).html").path) } ?? false }.reversed().prefix(12))
        let rest = lines.filter { !($0["id"] as? String ?? "").hasPrefix("notice-") && !quiet.contains($0["did"] as? String ?? "") }
        func isJob(_ l: [String: Any]) -> Bool { (l["did"] as? String ?? "").hasPrefix("doing the job") }
        let hand = ["pressing", "typing", "clicking", "opening", "checking for anything waiting", "hands", "reading back", "watching you"]
        func byHand(_ l: [String: Any]) -> Bool { let d = l["did"] as? String ?? ""; return hand.contains { d.hasPrefix($0) } }
        let forgotten = Set((try? JSONDecoder().decode([String].self, from: Data(contentsOf: dir.appendingPathComponent("forgotten.json")))) ?? [])
        func jobName(_ l: [String: Any]) -> String { String((l["did"] as? String ?? "").dropFirst("doing the job ".count)) }
        var lastRun: [String: [String: Any]] = [:]
        for l in rest where isJob(l) { lastRun[jobName(l)] = l }
        let stopped = lastRun.values.filter { l in
            let said = l["said"] as? String ?? ""
            return !(l["ok"] as? Bool ?? false) && said.contains("stopped at step") && !forgotten.contains(l["id"] as? String ?? "")
        }.sorted { ($0["at"] as? Double ?? 0) < ($1["at"] as? Double ?? 0) }
        let refused = rest.filter { !($0["ok"] as? Bool ?? false) }.count - stopped.count
        let singles = rest.filter { ($0["ok"] as? Bool ?? false) && byHand($0) }.count
        let skipped = rest.filter { ($0["ok"] as? Bool ?? false) && ($0["said"] as? String ?? "").contains("not needed") }
        let did = rest.filter { ($0["ok"] as? Bool ?? false) && !byHand($0) && !($0["said"] as? String ?? "").contains("not needed") }
        let waiting = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: waitingURL))) as? [[String: Any]]) ?? []
        var pics = ""
        // Only real pictures go in the page, shrunk for a phone. The page once named itself as a
        // picture and swallowed its own copy on every refresh until it was gigabytes.
        for name in lines.compactMap({ $0["picture"] as? String }).filter({ $0.hasSuffix(".png") }).suffix(2) {
            if let d = try? Data(contentsOf: dir.appendingPathComponent(name)), let j = Door.small(d) {
                pics += "<img alt=\"the screen\" src=\"data:image/jpeg;base64,\(j.base64EncodedString())\">"
            }
        }
        func section(_ title: String, _ rows: [String], empty: String) -> String {
            "<h2>\(title) <em>\(rows.count)</em></h2>" + (rows.isEmpty ? "<p>\(empty)</p>" : "<ul>\(rows.joined())</ul>")
        }
        // Everything left for the owner comes with buttons. A button is a one-time offer this page made; nothing else can be clicked into action.
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        var offers: [String: DoorAsk] = [:]
        var choices: [[String: String]] = [], asks: [[String: Any]] = []
        func closeRow(_ says: String) { asks.append(["says": says, "choices": choices]); choices = [] }
        func button(_ label: String, _ ask: DoorAsk, quiet: Bool = false) -> String {
            let k = "o\(offers.count + 1)"; offers[k] = ask; choices.append(["offer": k, "label": label])
            return "<a class=\"btn\(quiet ? " quiet" : "")\" href=\"openrappter://pick/\(token)/\(k)\">\(esc(label))</a>"
        }
        var left: [String] = []
        for b in waiting {
            let app = b["app"] as? String ?? "", words = (b["words"] as? [String]) ?? []
            let text = Door.boxSays(words)
            let all = Door.boxButtons(words), buttons = all.prefix(4)
            let why = b["cause"] as? String
            var row = "<li class=\"ask\"><b>\(esc(app)) is asking: \(esc(text.isEmpty ? "a question with no words I could read" : text))</b>\(why.map { "<br><span style=\"opacity:.7;white-space:normal\">It came up \(esc($0)).</span>" } ?? "")<div>"
            row = Door.yours(row, app: app, otherMacs: !peers().isEmpty)
            for name in buttons { var a = DoorAsk(id: "", do: "press"); a.title = name; a.app = app; row += button("Press \(name)", a) }
            // The same answers, made to stick. Not offered for boxes that guard the Mac, or ones I cannot read.
            if !text.isEmpty, !Door.gates.contains(app) {
                row += "</div><div><span style=\"opacity:.6;align-self:center\">Every time:</span>"
                for name in buttons {
                    var a = DoorAsk(id: "", do: "always"); a.title = name; a.app = app; a.text = text
                    a.steps = all.map { var s = DoorAsk(id: "", do: "press"); s.title = $0; return s }
                    row += button("Always \(name)", a, quiet: true)
                }
            }
            left.append(row + "</div></li>")
            closeRow("\(app) is asking: \(text)")
            if let why { asks[asks.count - 1]["cause"] = why }
        }
        for f in ((try? FileManager.default.contentsOfDirectory(at: questionsDir, includingPropertiesForKeys: nil)) ?? []).sorted(by: { $0.path < $1.path })
        where f.pathExtension == "json" && !f.lastPathComponent.hasSuffix(".answer.json") {
            guard let q = try? JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [String: Any], let qid = q["id"] as? String else { continue }
            let title = q["title"] as? String ?? "", text = q["text"] as? String ?? ""
            var row = "<li class=\"ask\"><b>\(esc(title))</b>\(text.isEmpty ? "" : "<br><span style=\"opacity:.7;white-space:normal\">\(esc(text))</span>")<div>"
            for (i, c) in ((q["choices"] as? [String]) ?? []).enumerated() {
                var a = DoorAsk(id: "", do: "answer"); a.text = qid; a.title = c
                row += button(c, a, quiet: i > 0)
            }
            left.append(row + "</div></li>")
            closeRow(text.isEmpty ? title : "\(title) \(text)")
        }
        for l in stopped {
            let name = jobName(l)
            var again = DoorAsk(id: "", do: "job"); again.title = name
            var forget = DoorAsk(id: "", do: "forget"); forget.text = l["id"] as? String
            left.append("<li class=\"ask\"><b>\(esc(l["said"] as? String ?? ""))</b><div>\(button("Try it again", again))\(button("Leave it", forget, quiet: true))</div></li>")
            closeRow(l["said"] as? String ?? "")
        }
        var standing: [String] = [], sticks: [[String: Any]] = []
        for r in alwaysRules() {
            var off = DoorAsk(id: "", do: "always"); off.app = r.app; off.title = r.press; off.text = r.says; off.key = "off"
            let b = button("Ask me again instead", off, quiet: true)
            sticks.append(["app": r.app, "says": r.says, "press": r.press, "choices": choices])
            standing.append("<li class=\"ask\"><b>When \(esc(r.app)) asks \"\(esc(r.says))\" I press \(esc(r.press)).</b><div>\(b)</div></li>")
            choices = []
        }
        if held {
            left.append("<li class=\"ask\"><b>Hands off is on, so I am only looking.</b><div>\(button("Let me work again", DoorAsk(id: "", do: "resume")))</div></li>")
            closeRow("Hands off is on, so I am only looking.")
        }
        let enc = JSONEncoder()
        if let d = try? enc.encode(["token": [DoorAsk(id: token, do: "token")], "offers": Array(offers.keys.sorted().map { k in var a = offers[k]!; a.id = k; return a })]) {
            let u = dir.appendingPathComponent("offers.json"); try? d.write(to: u, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: u.path)
        }
        let host = Host.current().localizedName ?? "this Mac"
        // The same thing as data, for a phone app later: what is left, and the choices for each.
        let leftDoc: [String: Any] = ["schema": "openrappter-door/1", "mac": host, "at": now.timeIntervalSince1970, "held": held,
                                      "token": token, "left": asks, "always": sticks]
        if let d = try? JSONSerialization.data(withJSONObject: leftDoc, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: dir.appendingPathComponent("left.json"), options: .atomic)
        }
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="30"><title>While you were away</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:34px;margin:0}h2{font-size:20px;margin:34px 0 8px;color:#f0a04b}h2 em{font-style:normal;opacity:.6}
        ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #2c2622}
        li b{font-weight:500}li span{opacity:.55;white-space:nowrap}li span a{color:#f0a04b}p{opacity:.6}img{width:100%;border-radius:12px;margin-top:14px}
        .sub{opacity:.6;margin:4px 0 0}
        li.ask{display:block}li.ask div{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap}
        .btn{background:#f0a04b;color:#14110f;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:10px}
        .btn.quiet{background:#2c2622;color:#f3ece4}</style>
        <h1>While you were away</h1><p class="sub">\(esc(host)), the last \(Int(hours)) hours\(held ? ". Hands off is on." : "")</p>
        \(section("Left for you", left, empty: "Nothing. You do not need to do anything."))
        \(standing.isEmpty ? "" : section("Answers you made stick", standing, empty: ""))
        \(section("What I did", did.map(row), empty: "Nothing needed doing."))
        \(singles + refused > 0 ? "<p>Also \(singles) single presses and looks asked for by hand\(refused > 0 ? ", and \(refused) asks I turned down" : "").</p>" : "")
        \(proofs.isEmpty ? "" : section("See what changed", proofs.map(row), empty: ""))
        \(section("What I skipped because it was already done", skipped.map(row), empty: "Nothing."))
        \(section("What I noticed", noticed.map(row), empty: "No box sat waiting."))
        \(pics.isEmpty ? "" : "<h2>The screen, last seen</h2>" + pics)
        """
        let ok = (try? Data(html.utf8).write(to: dir.appendingPathComponent("page.html"), options: .atomic)) != nil
        return (ok, "page ready: \(did.count) done, \(skipped.count) skipped, \(left.count) left for you, \(noticed.count) noticed")
    }

    // MARK: teach by showing

    func startShowing(_ name: String) {
        stopShowing()
        shownName = name; shownSteps = []; shownTyped = ""; shownMice = 0; shownKeys = 0
        let mask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                          eventsOfInterest: CGEventMask(mask), callback: { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let door = Unmanaged<Door>.fromOpaque(info).takeUnretainedValue()
            let spot = event.location, flags = NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue))
            let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
            var chars: String?, bare: String?
            if type == .keyDown {
                var n = 0; var buf = [UniChar](repeating: 0, count: 8)
                event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &n, unicodeString: &buf)
                if n > 0 { chars = String(utf16CodeUnits: buf, count: n); bare = chars?.lowercased() }
            }
            Task { @MainActor in door.sawOwner(mouse: type == .leftMouseDown, code: code, flags: flags, chars: chars, bare: bare, spot: spot) }
            return Unmanaged.passUnretained(event)
        }, userInfo: me) else { return }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        showMonitor = tap
    }

    func stopShowing() {
        if let m = showMonitor { CGEvent.tapEnable(tap: m as! CFMachPort, enable: false); CFMachPortInvalidate((m as! CFMachPort)) }
        showMonitor = nil
        flushTyped()
    }

    func flushTyped() {
        guard !shownTyped.isEmpty else { return }
        var s = DoorAsk(id: "", do: "type"); s.text = shownTyped; shownSteps.append(s); shownTyped = ""
    }

    func sawOwner(mouse: Bool, code: UInt16, flags: NSEvent.ModifierFlags, chars: String?, bare: String?, spot: CGPoint) {
        guard showMonitor != nil, shownSteps.count < 200 else { return }
        if mouse { shownMice += 1 } else { shownKeys += 1 }
        let front = NSWorkspace.shared.frontmostApplication?.localizedName
        if mouse {
            flushTyped()
            if let step = Door.step(forPressAt: spot, app: front) { shownSteps.append(step) }
            return
        }
        let named: [UInt16: String] = [36: "return", 48: "tab", 51: "delete", 53: "escape", 123: "left", 124: "right", 125: "down", 126: "up"]
        var mods: [String] = []
        if flags.contains(.command) { mods.append("command") }
        if flags.contains(.control) { mods.append("control") }
        if flags.contains(.option) { mods.append("option") }
        if let step = Door.step(forKey: named[code], bare: bare, mods: mods, shift: flags.contains(.shift)) {
            flushTyped(); var s = step; s.wait = 0.5; shownSteps.append(s)
        } else if let c = chars, !Door.focusIsSecret() { shownTyped += c }
    }

    /// True when the cursor is in a password field. Nothing typed there is ever kept.
    static func focusIsSecret() -> Bool {
        guard let f = Screen.attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as String) else { return false }
        let el = f as! AXUIElement
        return (Screen.attr(el, kAXSubroleAttribute as String) as? String) == "AXSecureTextField"
            || (Screen.attr(el, kAXRoleDescriptionAttribute as String) as? String)?.lowercased().contains("secure") == true
    }

    /// A key the owner pressed becomes a key step only when it is a named key or a shortcut. Plain letters are typing.
    public static func step(forKey named: String?, bare: String?, mods: [String], shift: Bool) -> DoorAsk? {
        var s = DoorAsk(id: "", do: "key")
        if let n = named { s.key = n; s.with = (mods + (shift ? ["shift"] : [])).isEmpty ? nil : mods + (shift ? ["shift"] : []); return s }
        guard mods.contains("command") || mods.contains("control"), let b = bare?.lowercased(), b.count == 1, Screen.keyCode(b) != nil else { return nil }
        s.key = b; s.with = mods + (shift ? ["shift"] : []); return s
    }

    /// What the owner pressed, by the words on it. Falls back to the spot only when the thing has no words.
    static func step(forPressAt p: CGPoint, app: String?) -> DoorAsk? {
        var el: AXUIElement?
        let sys = AXUIElementCreateSystemWide()
        var name = ""
        if AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success, var cur = el {
            for _ in 0..<4 {
                let role = (Screen.attr(cur, kAXRoleAttribute as String) as? String) ?? ""
                let l = Screen.label(cur)
                if !l.isEmpty, role != "AXWindow", role != "AXApplication" { name = l; break }
                guard let parent = Screen.attr(cur, kAXParentAttribute as String) else { break }
                cur = parent as! AXUIElement
            }
        }
        if name.isEmpty { var s = DoorAsk(id: "", do: "click"); s.x = Double(p.x); s.y = Double(p.y); s.wait = 0.7; return s }
        var s = DoorAsk(id: "", do: "press"); s.title = String(name.prefix(80)); s.app = app; s.wait = 0.7; return s
    }
}

extension Screen {
    static func windowFacts() -> [String] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.flatMap { app -> [String] in
            let root = AXUIElementCreateApplication(app.processIdentifier)
            return ((attr(root, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).map { w in
                let kids = ((attr(w, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []).map { (attr($0, kAXRoleAttribute as String) as? String) ?? "?" }
                return "\(app.localizedName ?? "?") | \(label(w).prefix(30)) | role \((attr(w, kAXRoleAttribute as String) as? String) ?? "") | sub \((attr(w, kAXSubroleAttribute as String) as? String) ?? "") | modal \(String(describing: attr(w, kAXModalAttribute as String))) | kids \(Set(kids).sorted().joined(separator: ","))"
            }
        }
    }

    /// Boxes that are waiting for an answer: system alerts, and sheets or dialogs in the app in front.
    public static func boxes() -> [(app: String, words: [String])] {
        guard AXIsProcessTrusted() else { return [] }
        let always = ["UserNotificationCenter", "CoreServicesUIAgent", "SecurityAgent", "NetAuthAgent"]
        let apps = NSWorkspace.shared.runningApplications.filter {
            ($0.activationPolicy == .regular || always.contains($0.localizedName ?? "")) && $0.processIdentifier != getpid()
        }
        var out: [(String, [String])] = []
        for app in apps {
            let name = app.localizedName ?? "an app"
            let root = AXUIElementCreateApplication(app.processIdentifier)
            for win in (attr(root, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
                                // A box is a window that offers a default or a cancel button. What a window calls itself is not reliable.
                let asks = attr(win, kAXDefaultButtonAttribute as String) != nil || attr(win, kAXCancelButtonAttribute as String) != nil
                var box: AXUIElement? = (asks || always.contains(name)) ? win : nil
                if box == nil {
                    box = ((attr(win, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [])
                        .first { (attr($0, kAXRoleAttribute as String) as? String) == "AXSheet" }
                }
                // A panel with no close button counts only if it offers Cancel.
                var needCancel = false
                if box == nil, attr(win, kAXCloseButtonAttribute as String) == nil,
                   (attr(win, kAXRoleAttribute as String) as? String) == "AXWindow" { box = win; needCancel = true }
                guard let b = box else { continue }
                var words: [String] = [], queue = [b], n = 0
                while !queue.isEmpty, n < 400 {
                    let el = queue.removeFirst(); n += 1
                    let role = (attr(el, kAXRoleAttribute as String) as? String) ?? ""
                    let l = label(el)
                    if !l.isEmpty, role == "AXButton" || role == "AXStaticText" { words.append("\(role.dropFirst(2)): \(l.prefix(100))") }
                    queue += (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
                }
                if needCancel, !words.contains("Button: Cancel") { continue }
                if words.contains(where: { $0.hasPrefix("Button") }) {
                    let buttons = words.filter { $0.hasPrefix("Button") }, text = words.filter { !$0.hasPrefix("Button") }
                    out.append((name, Array(text.prefix(4)) + Array(buttons.prefix(8))))
                }
            }
        }
        return out.map { (app: $0.0, words: $0.1) }
    }
}

/// Which apps were open, and on which system, the last time the door looked.
public struct DoorPlace: Codable, Equatable {
    public var at: Double, apps: [String], names: [String], os: String
}

/// A standing answer: when this app asks exactly this, press this.
public struct DoorAlways: Codable, Equatable {
    public var app: String, says: String, buttons: [String], press: String, since: Double
}

extension Door {
    /// Boxes that guard the Mac itself. They never get a standing answer.
    public static let gates: Set<String> = ["UserNotificationCenter", "SecurityAgent", "CoreServicesUIAgent", "NetAuthAgent"]
    var alwaysURL: URL { dir.appendingPathComponent("always.json") }
    public func alwaysRules() -> [DoorAlways] { (try? JSONDecoder().decode([DoorAlways].self, from: Data(contentsOf: alwaysURL))) ?? [] }
    func saveAlways(_ r: [DoorAlways]) -> Bool {
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? enc.encode(r).write(to: alwaysURL, options: .atomic)) != nil
    }
    // MARK: restarts and updates

    var placeURL: URL { dir.appendingPathComponent("place.json") }
    /// Remembers which apps are open. After a restart it reopens the ones that did not come back, and says if the Mac was updated.
    func keepPlace(now: Date, bootedAt: Date, running: [(name: String, path: String)], os: String, open: (String) -> Bool) {
        guard !held else { return }
        let old = try? JSONDecoder().decode(DoorPlace.self, from: Data(contentsOf: placeURL))
        func save() {
            let mine = Bundle.main.bundlePath
            let keep = running.filter { $0.path != mine && !$0.path.hasPrefix("/private/") && !$0.path.hasPrefix("/tmp/") }
            let p = DoorPlace(at: now.timeIntervalSince1970, apps: keep.map(\.path), names: keep.map(\.name), os: os)
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            try? enc.encode(p).write(to: placeURL, options: .atomic)
        }
        guard let p = old else { save(); return }
        if p.at < bootedAt.timeIntervalSince1970 - 1 {
            // Saved before this restart. Give the Mac a minute and a half to bring its own things back first.
            guard now.timeIntervalSince(bootedAt) >= 90 else { return }
            var back: [String] = [], lost: [String] = []
            if now.timeIntervalSince1970 - p.at < 7 * 86400 {
                let here = Set(running.map(\.path))
                for (path, name) in zip(p.apps, p.names) where !here.contains(path) {
                    if FileManager.default.fileExists(atPath: path), open(path) { back.append(name) } else { lost.append(name) }
                }
            }
            var said = "this Mac restarted. " + (back.isEmpty ? "Everything that was open came back by itself" : "I reopened \(back.joined(separator: ", "))")
            if !lost.isEmpty { said += ". I could not reopen \(lost.joined(separator: ", "))" }
            if p.os != os { said += ". It was updated from \(p.os) to \(os)" }
            var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-place", do: "notice"); ask.app = "this Mac"
            record(ask, DoorAnswer(id: ask.id, ok: true, said: said, front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            save()
        } else if now.timeIntervalSince1970 - p.at >= 300 { save() }
    }

    var updatesURL: URL { dir.appendingPathComponent("updates.json") }
    /// The names of the updates Apple's own tool lists as waiting.
    public nonisolated static func updateNames(_ listing: String) -> [String] {
        listing.split(separator: "\n").compactMap { l in
            let t = l.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("* Label: ") ? String(t.dropFirst(9)) : nil
        }
    }
    /// Once a day, asks Apple's own tool what updates are waiting and says so when the list changes. It never installs: that needs this Mac's password.
    func checkUpdates(now: Date, list: (@Sendable () -> String)? = nil) {
        let last = (try? JSONSerialization.jsonObject(with: Data(contentsOf: updatesURL))) as? [String: Any]
        guard !updatesBusy, now.timeIntervalSince1970 - (last?["at"] as? Double ?? 0) >= 86400 else { return }
        updatesBusy = true
        let run: @Sendable () -> String = list ?? {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/softwareupdate"); p.arguments = ["-l"]
            let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
            guard (try? p.run()) != nil else { return "" }
            let d = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
            return String(data: d, encoding: .utf8) ?? ""
        }
        Task.detached {
            let names = Door.updateNames(run())
            await MainActor.run {
                self.updatesBusy = false
                let before = (last?["names"] as? [String]) ?? []
                if let d = try? JSONSerialization.data(withJSONObject: ["at": now.timeIntervalSince1970, "names": names], options: [.sortedKeys]) { try? d.write(to: self.updatesURL, options: .atomic) }
                guard !names.isEmpty, names != before else { return }
                var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-updates", do: "notice"); ask.app = "this Mac"
                let said = "\(names.count) update\(names.count == 1 ? " is" : "s are") waiting for this Mac: \(names.joined(separator: ", ")). Installing needs this Mac's password, so that part is yours"
                self.record(ask, DoorAnswer(id: ask.id, ok: true, said: said, front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            }
        }
    }

    // MARK: chores in plain words

    public nonisolated static func days(_ on: [Int]?) -> String {
        guard let on, !on.isEmpty, Set(on).count < 7 else { return "every day" }
        if Set(on) == [2, 3, 4, 5, 6] { return "every weekday" }
        let names = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return "every " + on.sorted().filter { (1...7).contains($0) }.map { names[$0] }.joined(separator: " and ")
    }
    /// Reads "every Friday at 9, export last week's orders" into what to do and when. Nil when no time or day is said.
    public nonisolated static func chore(_ sentence: String) -> (title: String, at: String?, every: Double?, on: [Int]?)? {
        var rest = sentence
        func cut(_ pattern: String) -> [String]? {
            guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                  let m = re.firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)), let whole = Range(m.range, in: rest) else { return nil }
            let groups = (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: rest).map { String(rest[$0]) } ?? "" }
            rest.replaceSubrange(whole, with: " ")
            return groups
        }
        var every: Double? = nil, at: String? = nil, on: [Int]? = nil, daySaid = false
        if let g = cut("\\bevery\\s+(\\d+)?\\s*(minutes?|mins?|hours?|hrs?)\\b") {
            every = Double(Int(g[1]) ?? 1) * (g[2].lowercased().hasPrefix("h") ? 60 : 1)
        }
        let day = "(?:mon|tues|wednes|thurs|fri|satur|sun)days?"
        if let g = cut("\\b(?:every|each|on)\\s+((?:\(day)|weekdays?|days?)(?:\\s*(?:,|and|,\\s*and)\\s*\(day))*)") {
            daySaid = true
            let l = g[1].lowercased()
            if l.contains("weekday") { on = [2, 3, 4, 5, 6] }
            else {
                let found = ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"].enumerated().filter { l.contains($0.element + "day") }.map { $0.offset + 1 }
                on = found.isEmpty ? nil : found
            }
        } else if cut("\\bdaily\\b") != nil { daySaid = true }
        if cut("\\b(?:at\\s+)?noon\\b") != nil { at = "12:00" }
        else if cut("\\b(?:at\\s+)?midnight\\b") != nil { at = "00:00" }
        else if let g = cut("\\bat\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?(?![\\w:])") {
            var h = Int(g[1]) ?? 0; let m = Int(g[2]) ?? 0, half = g[3].lowercased()
            if half.hasPrefix("p"), h < 12 { h += 12 }; if half.hasPrefix("a"), h == 12 { h = 0 }
            guard (0..<24).contains(h), (0..<60).contains(m) else { return nil }
            at = String(format: "%02d:%02d", h, m)
        }
        if every != nil { at = nil; on = nil } else if at == nil { guard daySaid else { return nil }; at = "09:00" }
        var title = rest.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:!"))
        for lead in ["and ", "then ", "please "] where title.lowercased().hasPrefix(lead) { title = String(title.dropFirst(lead.count)) }
        title = String(title.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:!")).prefix(60))
        guard title.contains(where: { $0.isLetter }) else { return nil }
        return (title, at, every, on)
    }

    // MARK: signed out

    /// Browsers show sign-in pages all day; that is not an app signing the owner out.
    public static let browsers: Set<String> = ["Safari", "Google Chrome", "Microsoft Edge", "Firefox", "Arc", "Brave Browser"]
    /// The words on an app's window that mean it wants the owner to sign in again. Nil when it does not.
    public nonisolated static func signedOut(_ words: [String]) -> String? {
        let tells = ["signed out", "sign in again", "log in again", "session expired", "session has expired", "please sign in", "please log in",
                     "sign in to continue", "log in to continue", "sign me in", "you need to sign in", "reauthenticate", "re-authenticate", "verify your account"]
        for w in words {
            let text = w.drop(while: { $0 != ":" }).dropFirst(2).lowercased()
            if text.count <= 160, tells.contains(where: { text.contains($0) }) { return String(w.drop(while: { $0 != ":" }).dropFirst(2)) }
        }
        return nil
    }
    /// An app that sits on a sign-in screen for two looks in a row is told to the owner, once a day, before a job fails on it.
    func noticeSignOuts(_ apps: [(app: String, words: [String])], now: Date) {
        var seenNow: Set<String> = []
        for a in apps {
            guard let phrase = Door.signedOut(a.words) else { continue }
            seenNow.insert(a.app)
            guard signSeen.contains(a.app), now.timeIntervalSince(signTold[a.app] ?? .distantPast) >= 86400 else { continue }
            signTold[a.app] = now
            var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-signin-\(slug(a.app))", do: "notice"); ask.app = a.app
            record(ask, DoorAnswer(id: ask.id, ok: true, said: "\(a.app) wants you to sign in again (it says \"\(phrase)\"). Jobs that use it will not work until you do", front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            onAct?("\(a.app) wants you to sign in again"); onDone?()
        }
        signTold = signTold.filter { seenNow.contains($0.key) || now.timeIntervalSince($0.value) < 86400 }
        signSeen = seenNow
    }

    // MARK: before and after

    var proofDir: URL { dir.appendingPathComponent("proof") }
    /// Every time the door acts, it keeps a picture from just before and just after, so the owner can see what changed.
    /// Like a dashcam: a fixed number is kept and the oldest fall off.
    func withProof(_ ask: DoorAsk, keep: Int = 200, run: () async -> DoorAnswer) async -> (DoorAnswer, String?) {
        guard !held, ["press", "click", "type", "key", "open", "job", "always"].contains(ask.do) else { return (await run(), nil) }
        let fm = FileManager.default
        try? fm.createDirectory(at: proofDir, withIntermediateDirectories: true)
        let name = String(ask.id.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" }.prefix(80))
        let before = proofDir.appendingPathComponent("\(name)-before.jpg"), after = proofDir.appendingPathComponent("\(name)-after.jpg")
        let gotBefore = await snap(before)
        let answer = await run()
        guard gotBefore, answer.ok else { try? fm.removeItem(at: before); return (answer, nil) }
        try? await Task.sleep(for: .milliseconds(700))
        guard await snap(after) else { try? fm.removeItem(at: before); return (answer, nil) }
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let f = DateFormatter(); f.dateFormat = "EEE d MMM, HH:mm:ss"
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Before and after</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:28px;margin:0}h2{font-size:20px;margin:30px 0 8px;color:#f0a04b}p{opacity:.6;margin:4px 0}img{width:100%;border-radius:12px}a{color:#f0a04b}</style>
        <p><a href="../page.html" onclick="history.back();return false">Back</a></p>
        <h1>\(esc(answer.said))</h1><p>\(esc(Door.line(ask))), \(f.string(from: Date(timeIntervalSince1970: answer.at)))</p>
        <h2>Before</h2><img alt="the screen before" src="\(name)-before.jpg">
        <h2>After</h2><img alt="the screen after" src="\(name)-after.jpg">
        """
        guard (try? Data(html.utf8).write(to: proofDir.appendingPathComponent("\(name).html"), options: .atomic)) != nil else { return (answer, nil) }
        let pages = ((try? fm.contentsOfDirectory(at: proofDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []).filter { $0.pathExtension == "html" }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for old in pages.dropFirst(keep) {
            let base = old.deletingPathExtension().lastPathComponent
            for f in ["\(base).html", "\(base)-before.jpg", "\(base)-after.jpg"] { try? fm.removeItem(at: proofDir.appendingPathComponent(f)) }
        }
        return (answer, name)
    }

    /// The owner's other Macs that run a door, for the one page: peers.json = [{"name": "...", "at": "100.x.y.z"}].
    public func peers() -> [(name: String, at: String, lan: String?)] {
        let list = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("peers.json")))) as? [[String: String]]) ?? []
        return list.compactMap { p in p["at"].map { (p["name"] ?? $0, $0, p["lan"]) } }
    }

    // MARK: covering for another Mac

    var peersSeenURL: URL { dir.appendingPathComponent("peers-seen.json") }
    /// What this Mac tells the others when they check on it: that it is alive, and which clock jobs they should run if it goes quiet.
    public func beat(now: Date = Date()) -> [String: Any] {
        let fired = (try? JSONDecoder().decode([String: Double].self, from: Data(contentsOf: firedURL))) ?? [:]
        let cover: [[String: Any]] = watches().filter { $0.cover == true && $0.see == nil }.map { w in
            var o: [String: Any] = ["title": w.title, "job": w.job, "fired": fired[w.title] ?? 0]
            if let at = w.at { o["at"] = at }; if let e = w.every { o["every"] = e }
            return o
        }
        let left = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("left.json")))) as? [String: Any])?["left"] as? [Any]
        return ["schema": "openrappter-door/1", "mac": Host.current().localizedName ?? "this Mac", "at": now.timeIntervalSince1970, "held": held, "left": left?.count ?? 0, "cover": cover, "needs": needs()]
    }
    /// Another Mac reported in. That proves it is alive and nothing more: the jobs to cover are only ever read by asking it directly.
    @discardableResult public func reportedIn(mac: String, now: Date = Date()) -> Bool {
        func flat(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }
        guard let p = peers().first(where: { !flat($0.name).isEmpty && flat(mac).hasPrefix(flat($0.name)) }) else { return false }
        let st = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: peersSeenURL))) as? [String: [String: Any]])?[p.name]
        _ = peerBeat(name: p.name, heard: (st?["cover"] as? [[String: Any]]) ?? [], now: now)
        return true
    }
    /// One check on another Mac. `heard` is what it said, or nil when it did not answer.
    /// Three minutes of silence is "gone quiet" (one missed beat is not). While it is quiet, its covered clock jobs that this Mac
    /// also knows come back as due; when it answers again the covering stops. A dropped link looks the same as a dead Mac,
    /// so only jobs the owner marked for cover are ever run here.
    func peerBeat(name: String, heard: [[String: Any]]?, now: Date, calendar: Calendar = .current) -> [DoorWatch] {
        var all = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: peersSeenURL))) as? [String: [String: Any]]) ?? [:]
        var st = all[name] ?? [:]
        defer { all[name] = st; if let d = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: peersSeenURL, options: .atomic) } }
        func tell(_ said: String) {
            var ask = DoorAsk(id: "notice-\(Int(now.timeIntervalSince1970))-peer-\(slug(name))", do: "notice"); ask.app = name
            record(ask, DoorAnswer(id: ask.id, ok: true, said: said, front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970))
            onAct?(said); onDone?()
        }
        if let heard {
            if st["quiet"] as? Bool == true, let since = st["seen"] as? Double {
                tell("\(name) is back after \(Int((now.timeIntervalSince1970 - since) / 60)) min of quiet. I have stopped covering for it")
            }
            st = ["seen": now.timeIntervalSince1970, "cover": heard, "quiet": false]
            return []
        }
        guard let seen = st["seen"] as? Double, now.timeIntervalSince1970 - seen >= 180 else { return [] }
        let theirs = ((st["cover"] as? [[String: Any]]) ?? []).compactMap { o -> (DoorWatch, Double)? in
            guard let t = o["title"] as? String, let j = o["job"] as? String, let u = learnedURL(j), FileManager.default.fileExists(atPath: u.path) else { return nil }
            return (DoorWatch(title: t, job: j, see: nil, app: nil, at: o["at"] as? String, every: o["every"] as? Double, cover: true, on: nil), o["fired"] as? Double ?? 0)
        }
        if st["quiet"] as? Bool != true {
            st["quiet"] = true
            tell("\(name) has gone quiet: no answer for \(Int((now.timeIntervalSince1970 - seen) / 60)) min" +
                 (theirs.isEmpty ? "" : ". Until it is back I run its jobs: \(theirs.map { $0.0.title }.joined(separator: ", "))"))
        }
        guard !held else { return [] }
        var fired = (try? JSONDecoder().decode([String: Double].self, from: Data(contentsOf: firedURL))) ?? [:]
        var run: [DoorWatch] = []
        for (w, theirLast) in theirs {
            let key = "cover:\(name):\(w.title)"
            var mine = w; mine.title = key
            let last = max(fired[key] ?? 0, theirLast)
            if !Door.due([mine], now: now, fired: last > 0 ? [key: last] : [:], onScreen: [], lit: [], calendar: calendar).isEmpty {
                fired[key] = now.timeIntervalSince1970; run.append(w)
            }
        }
        if !run.isEmpty { try? FileManager.default.createDirectory(at: watchesDir, withIntermediateDirectories: true); try? JSONEncoder().encode(fired).write(to: firedURL, options: .atomic) }
        return run
    }
    /// The last thing this door did before a moment, from its own record.
    func lastActed(before t: Date) -> (at: Date, did: String)? {
        guard let text = try? String(contentsOf: dir.appendingPathComponent("log.jsonl"), encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n").suffix(200).reversed() {
            guard let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], o["ok"] as? Bool == true,
                  let at = o["at"] as? Double, at <= t.timeIntervalSince1970, let did = o["did"] as? String else { continue }
            if ["doing the job", "pressing", "clicking", "typing", "opening", "pressing the key"].contains(where: { did.hasPrefix($0) }) { return (Date(timeIntervalSince1970: at), did) }
        }
        return nil
    }
    /// The likeliest reason a box came up, in plain words, from what happened just before it. Nil when nothing stands out.
    public static func cause(since: Date, bootedAt: Date, appOpened: Date?, app: String, last: (at: Date, did: String)?) -> String? {
        if let l = last, since.timeIntervalSince(l.at) >= 0, since.timeIntervalSince(l.at) <= 20 { return "right after I was \(l.did)" }
        if let o = appOpened, since.timeIntervalSince(o) >= 0, since.timeIntervalSince(o) <= 60 {
            return since.timeIntervalSince(bootedAt) <= 300 ? "when \(app) opened after this Mac restarted" : "when \(app) opened"
        }
        if since.timeIntervalSince(bootedAt) >= 0, since.timeIntervalSince(bootedAt) <= 300 { return "right after this Mac restarted" }
        return nil
    }
    /// The words a box is asking, without its buttons.
    public static func boxSays(_ words: [String]) -> String {
        words.filter { !$0.hasPrefix("Button") }.map { String($0.drop(while: { $0 != ":" }).dropFirst(2)) }.prefix(2).joined(separator: " ")
    }
    public static func boxButtons(_ words: [String]) -> [String] {
        words.filter { $0.hasPrefix("Button: ") }.map { String($0.dropFirst(8)) }
    }
}

import ImageIO
import UniformTypeIdentifiers

extension Door {
    /// A picture shrunk to phone size (at most `side` points on its long edge), as a JPEG.
    public static func small(_ data: Data, side: Int = 1100) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceThumbnailMaxPixelSize: side,
                                     kCGImageSourceCreateThumbnailWithTransform: true]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}
