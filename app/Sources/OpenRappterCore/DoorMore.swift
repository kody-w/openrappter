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
            let w = DoorWatch(title: title, job: job, see: a.see, app: a.app, at: a.at, every: a.every)
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
            ans.ok = r.ok; ans.said = r.said; ans.picture = r.ok ? "page.html" : nil
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
        if let t = w.at { when.append("every day at \(t)") }
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
            guard now.timeIntervalSince(since) >= boxPatience else { continue }
            waitingNow.append(["app": b.app, "since": since.timeIntervalSince1970, "words": b.words])
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
            return "<li><b>\(esc(l["said"] as? String ?? ""))</b><span>\(t)</span></li>"
        }
        let quiet = ["looking at the screen", "listing the jobs I know", "listing what I watch for", "writing the page of what happened"]
        let noticed = lines.filter { ($0["id"] as? String ?? "").hasPrefix("notice-") }
        let rest = lines.filter { !($0["id"] as? String ?? "").hasPrefix("notice-") && !quiet.contains($0["did"] as? String ?? "") }
        func isJob(_ l: [String: Any]) -> Bool { (l["did"] as? String ?? "").hasPrefix("doing the job") }
        let hand = ["pressing", "typing", "clicking", "opening", "checking for anything waiting", "hands", "reading back", "watching you"]
        func byHand(_ l: [String: Any]) -> Bool { let d = l["did"] as? String ?? ""; return hand.contains { d.hasPrefix($0) } }
        let stopped = rest.filter { !($0["ok"] as? Bool ?? false) && isJob($0) }
        let refused = rest.filter { !($0["ok"] as? Bool ?? false) && !isJob($0) }.count
        let singles = rest.filter { ($0["ok"] as? Bool ?? false) && byHand($0) }.count
        let skipped = rest.filter { ($0["ok"] as? Bool ?? false) && ($0["said"] as? String ?? "").contains("not needed") }
        let did = rest.filter { ($0["ok"] as? Bool ?? false) && !byHand($0) && !($0["said"] as? String ?? "").contains("not needed") }
        let waiting = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: waitingURL))) as? [[String: Any]]) ?? []
        var pics = ""
        for name in lines.compactMap({ $0["picture"] as? String }).suffix(2) {
            if let d = try? Data(contentsOf: dir.appendingPathComponent(name)) {
                pics += "<img alt=\"the screen\" src=\"data:image/png;base64,\(d.base64EncodedString())\">"
            }
        }
        func section(_ title: String, _ rows: [String], empty: String) -> String {
            "<h2>\(title) <em>\(rows.count)</em></h2>" + (rows.isEmpty ? "<p>\(empty)</p>" : "<ul>\(rows.joined())</ul>")
        }
        let left = waiting.map { "<li><b>\(esc($0["app"] as? String ?? "")): \(esc((($0["words"] as? [String]) ?? []).prefix(4).joined(separator: "; ")))</b><span>waiting</span></li>" }
            + stopped.map(row)
        let host = Host.current().localizedName ?? "this Mac"
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>While you were away</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:34px;margin:0}h2{font-size:20px;margin:34px 0 8px;color:#f0a04b}h2 em{font-style:normal;opacity:.6}
        ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #2c2622}
        li b{font-weight:500}li span{opacity:.55;white-space:nowrap}p{opacity:.6}img{width:100%;border-radius:12px;margin-top:14px}
        .sub{opacity:.6;margin:4px 0 0}</style>
        <h1>While you were away</h1><p class="sub">\(esc(host)), the last \(Int(hours)) hours\(held ? ". Hands off is on." : "")</p>
        \(section("Left for you", left, empty: "Nothing is waiting on you."))
        \(section("What I did", did.map(row), empty: "Nothing needed doing."))
        \(singles + refused > 0 ? "<p>Also \(singles) single presses and looks asked for by hand\(refused > 0 ? ", and \(refused) asks I turned down" : "").</p>" : "")
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
