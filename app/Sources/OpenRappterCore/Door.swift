import AppKit
import ApplicationServices
import ScreenCaptureKit

/// One thing asked of the creature's eyes or hands on this Mac. Same folder pattern as a need:
/// drop `<id>.json` in ~/.openrappter/door/, read `<id>.answer.json` (and `<id>.png` for a look).
/// The door is a local folder only the owner can write to. Nothing here listens on the network.
public struct DoorAsk: Codable, Equatable {
    public var id: String
    /// look | press | click | type | key | open | learn | job | jobs
    public var `do`: String
    public var app: String?      // press / look: which app (default: the one in front)
    public var title: String?    // press: the words on the thing to press
    public var x: Double?        // click: screen points
    public var y: Double?
    public var text: String?     // type: the text; open: an app name or a link
    public var key: String?      // key: return, tab, space, escape, delete, up, down, left, right, or one letter
    public var with: [String]?   // key: command, shift, option, control
    public var steps: [DoorAsk]? // learn: the asks to keep under the name in `title`
    public var unless: String?   // a step inside a job: skip it when the screen already says this
    public var wait: Double?     // a step inside a job: seconds to wait after it
    public var job: String?      // watch: the learned job to run
    public var see: String?      // watch: run the job when the screen says this
    public var at: String?       // watch: run the job each day at this time, like 07:30
    public var every: Double?    // watch: run the job every this many minutes
    public var choices: [String]? // question: the answers the owner can pick from
    public init(id: String, do what: String) { self.id = id; self.do = what }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        `do` = try c.decode(String.self, forKey: .do)
        app = try c.decodeIfPresent(String.self, forKey: .app); title = try c.decodeIfPresent(String.self, forKey: .title)
        x = try c.decodeIfPresent(Double.self, forKey: .x); y = try c.decodeIfPresent(Double.self, forKey: .y)
        text = try c.decodeIfPresent(String.self, forKey: .text); key = try c.decodeIfPresent(String.self, forKey: .key)
        with = try c.decodeIfPresent([String].self, forKey: .with); steps = try c.decodeIfPresent([DoorAsk].self, forKey: .steps)
        unless = try c.decodeIfPresent(String.self, forKey: .unless); wait = try c.decodeIfPresent(Double.self, forKey: .wait)
        job = try c.decodeIfPresent(String.self, forKey: .job); see = try c.decodeIfPresent(String.self, forKey: .see)
        at = try c.decodeIfPresent(String.self, forKey: .at); every = try c.decodeIfPresent(Double.self, forKey: .every)
        choices = try c.decodeIfPresent([String].self, forKey: .choices)
    }
}

public struct DoorAnswer: Codable, Equatable {
    public var id: String
    public var ok: Bool
    public var said: String          // one plain line: what happened
    public var front: String?        // the app in front
    public var words: [String]?      // look: what is on screen, one thing per line
    public var picture: String?      // look: file name of the picture beside the answer
    public var at: Double
}

@MainActor
public final class Door {
    public let dir: URL
    /// Called with a plain line before each ask is carried out, so the creature can show it is being driven.
    public var onAct: ((String) -> Void)?
    public var onDone: (() -> Void)?
    private var fd: Int32 = -1
    private var source: DispatchSourceFileSystemObject?
    var busy = false
    private var seen: Set<String> = []
    var ticker: Timer?
    var lit: Set<String> = []              // sight watches already fired for what is on screen now
    var boxSince: [String: Date] = [:]     // boxes on screen and when each was first seen
    var boxTold: Set<String> = []
    /// Takes a phone-sized picture of the screen to a file. Swapped out in tests.
    public var snap: (URL) async -> Bool = { url in
        let tmp = url.deletingPathExtension().appendingPathExtension("png")
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard await Screen.picture(to: tmp), let d = try? Data(contentsOf: tmp), let j = Door.small(d, side: 1400) else { return false }
        return (try? j.write(to: url, options: .atomic)) != nil
    }
    var signLooked = Date.distantPast, signSeen: Set<String> = [], signTold: [String: Date] = [:]
    var peersLooked = Date.distantPast
    /// Bringing another Mac's screen to the owner. True when the owner is at this Mac; opens the screen at an address. Swapped out in tests.
    public var ownerHere: () -> Bool = { Door.ownerAtThisMac() }
    public var openScreen: (String) -> Bool = { Door.openScreenFor($0) }
    var broughtIds: [String: Set<String>] = [:], broughtAt = Date.distantPast
    var updatesBusy = false
    var boxCause: [String: String] = [:]      // why each waiting box came up, worked out once
    var alwaysFired: [String: [Date]] = [:]   // when each standing answer last pressed, so a box that keeps coming back cannot loop
    var showMonitor: Any?
    var shownSteps: [DoorAsk] = []
    var shownTyped = ""
    var shownName = ""
    var shownMice = 0
    var shownKeys = 0
    /// How long a box may sit before the creature says something is waiting.
    public var boxPatience: TimeInterval = 90
    /// Seconds since the owner last touched this Mac's own mouse or keys. Swapped out in tests.
    public var ownerIdle: () -> Double = Door.hardwareIdle
    /// The time now, for working out how long an ask has waited on the owner. Swapped out in tests.
    public var clock: () -> Date = { Date() }
    var polite = DoorPolite()                 // asks waiting for the owner to finish, and since when
    /// What an app's screen says, for noting what a job could see when it stopped fitting. Swapped out in tests.
    public var fitWords: (String?) -> [String] = { Screen.words(app: $0) }

    public init(dir: URL? = nil, watch: Bool = true) {
        self.dir = dir ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/door")
        try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.dir.path)
        if !watch { ownerIdle = { .infinity } }   // a door driven by hand never waits on the owner
        if watch {
            startWatching(); Task { await self.drain() }
            ticker = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in Task { @MainActor in await self?.tick() } }
        }
    }

    /// The asks still waiting, oldest first.
    public func waiting() -> [DoorAsk] {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let answered = Set(files.filter { $0.lastPathComponent.hasSuffix(".answer.json") }
            .map { $0.lastPathComponent.replacingOccurrences(of: ".answer.json", with: "") })
        let me = getuid()
        var found: [(DoorAsk, Date)] = []
        for f in files where f.pathExtension == "json" && !f.lastPathComponent.hasSuffix(".answer.json") {
            guard let attrs = try? fm.attributesOfItem(atPath: f.path),
                  (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == me,   // only the owner's own asks
                  let data = try? Data(contentsOf: f), let a = try? JSONDecoder().decode(DoorAsk.self, from: data),
                  !answered.contains(a.id), !seen.contains(a.id) else { continue }
            found.append((a, (attrs[.modificationDate] as? Date) ?? .distantPast))
        }
        return found.sorted { $0.1 < $1.1 }.map { $0.0 }
    }

    public func drain() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        while let ask = nextUp() {
            seen.insert(ask.id)
            onAct?(Door.line(ask))
            let (answer, proof) = await withProof(ask) { await self.carryOut(ask) }
            write(answer)
            record(ask, answer, proof: proof)
            onDone?()
        }
    }

    /// The plain line for the log and the creature: what is being done, never the text being typed.
    public static func line(_ a: DoorAsk) -> String {
        switch a.do {
        case "look": return "looking at the screen"
        case "press": return "pressing \(a.title ?? "a button")"
        case "click": return "clicking"
        case "type": return "typing \((a.text ?? "").count) characters"
        case "key": return "pressing the \(a.key ?? "") key"
        case "open": return "opening \(a.text ?? "")"
        case "learn": return "learning the job \(a.title ?? "")"
        case "job": return "doing the job \(a.title ?? "")"
        case "jobs": return "listing the jobs I know"
        case "hold": return "hands off"
        case "resume": return "hands back on"
        case "watch": return "keeping watch: \(a.title ?? "")"
        case "unwatch": return "no longer watching: \(a.title ?? "")"
        case "watches": return "listing what I watch for"
        case "boxes": return "checking for anything waiting"
        case "hear": return "rehearsing a spoken line"
        case "forget": return "leaving one alone, as told"
        case "notice": return "noticed a box waiting"
        case "question": return "asking you: \(a.title ?? "")"
        case "answer": return "took your answer: \(a.title ?? "")"
        case "page": return "writing the page of what happened"
        case "pack": return "packing my jobs for another Mac"
        case "chore": return "taking a chore in plain words"
        case "show": return "watching you do \(a.title ?? "a job")"
        case "shown": return "reading back what you showed me"
        case "yes": return "keeping the job \(a.title ?? "")"
        case "fits": return "checking which jobs still fit this Mac"
        default: return "asked for something I do not know: \(a.do)"
        }
    }

    func carryOut(_ a: DoorAsk) async -> DoorAnswer {
        var ans = DoorAnswer(id: a.id, ok: false, said: "", front: NSWorkspace.shared.frontmostApplication?.localizedName,
                             words: nil, picture: nil, at: Date().timeIntervalSince1970)
        if held, ["press", "click", "type", "key", "open", "job"].contains(a.do) {
            ans.said = "hands off is on, so I did not do that. Ask resume to let me work again."
            return ans
        }
        // Keys, typing and clicks land on whatever is in front. When an app is named, it must be the one in front, or nothing is sent.
        if ["key", "type", "click"].contains(a.do) {
            if let name = a.app, !name.isEmpty {
                guard let t = Screen.target(name) else { ans.said = "\(name) is not open, so I did not touch anything"; return ans }
                if NSWorkspace.shared.frontmostApplication != t { t.activate(); try? await Task.sleep(for: .milliseconds(500)) }
                guard NSWorkspace.shared.frontmostApplication == t else { ans.said = "could not bring \(name) to the front, so I did not touch anything"; return ans }
            } else if a.do == "key", a.key?.lowercased() == "q", (a.with ?? []).contains(where: { ["command", "cmd"].contains($0.lowercased()) }) {
                ans.said = "quitting needs the app named, so I did not press it"; return ans
            }
        }
        switch a.do {
        case "look":
            let name = "\(a.id).png"
            let got = await Screen.picture(to: dir.appendingPathComponent(name))
            let words = Screen.words(app: a.app)
            ans.picture = got ? name : nil
            ans.words = words
            ans.ok = got || !words.isEmpty
            ans.said = got ? "saw the screen, \(words.count) things named" :
                (words.isEmpty ? "could not see: screen and accessibility both not allowed" : "no picture (screen not allowed), \(words.count) things named")
        case "press":
            guard let t = a.title, !t.isEmpty else { ans.said = "press needs the words on the button"; break }
            let r = Screen.press(title: t, app: a.app)
            ans.ok = r.ok; ans.said = r.said
        case "click":
            guard let x = a.x, let y = a.y else { ans.said = "click needs x and y"; break }
            guard CGPreflightPostEventAccess() || AXIsProcessTrusted() else { ans.said = "not allowed to click yet"; break }
            Screen.click(CGPoint(x: x, y: y)); ans.ok = true; ans.said = "clicked"
        case "type":
            guard let t = a.text else { ans.said = "type needs text"; break }
            let how = await Dictation.paste(t)
            ans.ok = how != "denied"; ans.said = how == "denied" ? "not allowed to type yet" : "typed \(t.count) characters"
        case "key":
            guard let k = a.key, let code = Screen.keyCode(k) else { ans.said = "do not know that key"; break }
            guard CGPreflightPostEventAccess() || AXIsProcessTrusted() else { ans.said = "not allowed to press keys yet"; break }
            Screen.key(code, with: a.with ?? []); ans.ok = true; ans.said = "pressed \(k)"
        case "open":
            guard let t = a.text, !t.isEmpty else { ans.said = "open needs an app name or a link"; break }
            ans.ok = Screen.open(t); ans.said = ans.ok ? "opened \(t)" : "could not find \(t)"
        case "learn":
            guard let name = a.title, let steps = a.steps, !steps.isEmpty, let url = learnedURL(name) else { ans.said = "learn needs a name and steps"; break }
            if steps.contains(where: { ["learn", "job", "jobs"].contains($0.do) }) { ans.said = "a job cannot hold another job"; break }
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            ans.ok = (try? enc.encode(steps).write(to: url, options: .atomic)) != nil
            ans.said = ans.ok ? "learned \(name), \(steps.count) steps" : "could not keep \(name)"
        case "jobs":
            let names = ((try? FileManager.default.contentsOfDirectory(at: learned, includingPropertiesForKeys: nil)) ?? [])
                .filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "-", with: " ") }.sorted()
            ans.ok = true; ans.words = names; ans.said = "I know \(names.count) jobs"
        case "job":
            guard let name = a.title, let url = learnedURL(name), let data = try? Data(contentsOf: url),
                  let steps = try? JSONDecoder().decode([DoorAsk].self, from: data) else { ans.said = "I have not learned \(a.title ?? "that")"; break }
            var done = 0, skipped = 0
            ans.ok = true
            for (i, step) in steps.enumerated() {
                if held || waiting().contains(where: { $0.do == "hold" }) {
                    ans.ok = false; ans.said = "\(name) stopped before step \(i + 1): hands off"; break
                }
                if let u = step.unless, Screen.words(app: step.app).contains(where: { $0.localizedCaseInsensitiveContains(u) }) { skipped += 1; continue }
                var s = step; s.id = "\(a.id)-\(i + 1)"
                let r = await carryOut(s)
                if let w = step.wait { try? await Task.sleep(for: .milliseconds(Int(w * 1000))) }
                if !r.ok { ans.ok = false; ans.said = "\(name) stopped at step \(i + 1): \(r.said)"; break }
                done += 1
            }
            if ans.ok { ans.said = "\(name): \(done) steps done" + (skipped > 0 ? ", \(skipped) not needed" : "") }
            fitAfter(name, steps, ans)
        default:
            if !(await more(a, &ans)) { ans.said = "I do not know how to \(a.do)" }
        }
        if ["press", "click", "type", "key", "open"].contains(a.do) { try? await Task.sleep(for: .milliseconds(400)) }
        ans.front = NSWorkspace.shared.frontmostApplication?.localizedName
        return ans
    }

    /// Jobs worked out once and kept by name: ~/.openrappter/door/learned/<name>.json, a plain list of asks.
    public var learned: URL { dir.appendingPathComponent("learned") }
    func learnedURL(_ name: String) -> URL? {
        let slug = name.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
            .split(separator: "-").joined(separator: "-")
        guard !slug.isEmpty else { return nil }
        try? FileManager.default.createDirectory(at: learned, withIntermediateDirectories: true)
        return learned.appendingPathComponent("\(slug).json")
    }

    func write(_ answer: DoorAnswer) {
        let url = dir.appendingPathComponent("\(answer.id).answer.json")
        let tmp = dir.appendingPathComponent(".\(answer.id).answer.json.tmp")
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(answer) {
            try? data.write(to: tmp)
            _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
        }
    }

    /// Every ask is kept, one line each, so the owner can read everything that was done through the door.
    func record(_ ask: DoorAsk, _ answer: DoorAnswer, proof: String? = nil) {
        var line: [String: Any] = ["at": answer.at, "id": ask.id, "did": Door.line(ask), "ok": answer.ok, "said": answer.said]
        if let proof { line["proof"] = proof }
        if let p = answer.picture { line["picture"] = p }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        let url = dir.appendingPathComponent("log.jsonl")
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            _ = try? h.seekToEnd(); try? h.write(contentsOf: data + Data("\n".utf8))
        } else {
            try? (data + Data("\n".utf8)).write(to: url)
        }
    }

    private func startWatching() {
        fd = Darwin.open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename], queue: .main)
        s.setEventHandler { [weak self] in Task { @MainActor in await self?.drain() } }
        s.setCancelHandler { [fd = self.fd] in close(fd) }
        s.resume()
        source = s
    }
}

/// The eyes and hands themselves. Seeing needs Screen Recording; naming and pressing need Accessibility.
public enum Screen {
    public static func picture(to url: URL) async -> Bool {
        guard CGPreflightScreenCaptureAccess(),
              let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
              let display = content.displays.first else { return false }
        let cfg = SCStreamConfiguration()
        cfg.width = display.width; cfg.height = display.height; cfg.showsCursor = true
        guard let image = try? await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg) else { return false }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: url, options: .atomic)) != nil
    }

    static func target(_ app: String?) -> NSRunningApplication? {
        guard let app, !app.isEmpty else { return NSWorkspace.shared.frontmostApplication }
        return NSWorkspace.shared.runningApplications.first {
            $0.localizedName?.caseInsensitiveCompare(app) == .orderedSame || $0.bundleIdentifier == app
        }
    }

    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = attr(el, kAXPositionAttribute as String), let s = attr(el, kAXSizeAttribute as String) else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    static func label(_ el: AXUIElement) -> String {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXIdentifierAttribute] {
            if let s = attr(el, name as String) as? String, !s.isEmpty { return s }
        }
        return ""
    }

    /// Walks an app's windows and returns every element with its role, words and place. Capped.
    static func parts(of app: NSRunningApplication, cap: Int = 1500) -> [(el: AXUIElement, role: String, label: String, frame: CGRect?)] {
        let root = AXUIElementCreateApplication(app.processIdentifier)
        var out: [(AXUIElement, String, String, CGRect?)] = []
        var queue: [(AXUIElement, Int)] = ((attr(root, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).map { ($0, 0) }
        while !queue.isEmpty, out.count < cap {
            let (el, depth) = queue.removeFirst()
            let role = (attr(el, kAXRoleAttribute as String) as? String) ?? ""
            out.append((el, role, label(el), frame(el)))
            if depth < 40, let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
                queue.append(contentsOf: kids.map { ($0, depth + 1) })
            }
        }
        return out.map { (el: $0.0, role: $0.1, label: $0.2, frame: $0.3) }
    }

    /// What is on screen, in words: one line per thing that has words, with where it is.
    public static func words(app: String?) -> [String] {
        guard AXIsProcessTrusted(), let a = target(app) else { return [] }
        return parts(of: a).compactMap { p in
            guard !p.label.isEmpty else { return nil }
            let role = p.role.replacingOccurrences(of: "AX", with: "")
            var state = ""
            if ["AXCheckBox", "AXSwitch", "AXRadioButton"].contains(p.role), let v = attr(p.el, kAXValueAttribute as String) as? NSNumber {
                state = v.intValue == 0 ? " (off)" : " (on)"
            }
            let place = p.frame.map { " @\(Int($0.midX)),\(Int($0.midY))" } ?? ""
            return "\(role): \(p.label.prefix(120))\(state)\(place)"
        }
    }

    public static func press(title: String, app: String?) -> (ok: Bool, said: String) {
        guard AXIsProcessTrusted() else { return (false, "not allowed to press yet") }
        guard let a = target(app) else { return (false, "that app is not running") }
        let all = parts(of: a).filter { !$0.label.isEmpty && $0.role != "AXStaticText" }
        let want = title.lowercased()
        guard let hit = all.first(where: { $0.label.lowercased() == want }) ?? all.first(where: { $0.label.lowercased().contains(want) })
        else { return (false, "nothing on screen says \(title)") }
        if AXUIElementPerformAction(hit.el, kAXPressAction as CFString) == .success { return (true, "pressed \(hit.label.prefix(60))") }
        if let f = hit.frame { click(CGPoint(x: f.midX, y: f.midY)); return (true, "clicked \(hit.label.prefix(60))") }
        return (false, "found \(hit.label.prefix(60)) but could not press it")
    }

    public static func click(_ p: CGPoint) {
        let src = CGEventSource(stateID: .combinedSessionState)
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(60_000)
        }
    }

    public static func keyCode(_ name: String) -> CGKeyCode? {
        let named: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
                                          "left": 123, "right": 124, "down": 125, "up": 126]
        if let c = named[name.lowercased()] { return c }
        let letters: [Character: CGKeyCode] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
                                               "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35,
                                               "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43]
        guard name.count == 1, let ch = name.lowercased().first else { return nil }
        return letters[ch]
    }

    public static func key(_ code: CGKeyCode, with mods: [String]) {
        var flags: CGEventFlags = []
        for m in mods {
            switch m.lowercased() {
            case "command", "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "control", "ctrl": flags.insert(.maskControl)
            default: break
            }
        }
        let src = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
            e?.flags = flags; e?.post(tap: .cghidEventTap); usleep(40_000)
        }
    }

    public static func open(_ what: String) -> Bool {
        if what.contains(":"), let url = URL(string: what) { return NSWorkspace.shared.open(url) }
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        for base in ["/Applications", "/System/Applications", "/System/Applications/Utilities", home + "/Applications"] {
            let path = "\(base)/\(what).app"
            if fm.fileExists(atPath: path) { return NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
        }
        return false
    }
}
