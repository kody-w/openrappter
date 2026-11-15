import AppKit
import ApplicationServices

/// What this Mac allows right now. true = allowed, false = not allowed, nil = not known yet.
/// Plain values, so every decision below can be checked without a real Mac.
public struct DoorSetupFacts: Equatable, Sendable {
    public var pressing: Bool?       // Accessibility
    public var seeing: Bool?         // Screen Recording
    public var starting: Bool?       // opens by itself when the Mac starts
    public var hasOtherMacs: Bool    // the owner has named other Macs
    public var reaching: Bool?       // this Mac heard one of the others lately
    public var reached: Bool?        // one of the others reported in here
    public var understanding: Bool?  // speech
    public var hearing: Bool?        // microphone
    public init(pressing: Bool? = nil, seeing: Bool? = nil, starting: Bool? = nil, hasOtherMacs: Bool = false,
                reaching: Bool? = nil, reached: Bool? = nil, understanding: Bool? = nil, hearing: Bool? = nil) {
        self.pressing = pressing; self.seeing = seeing; self.starting = starting; self.hasOtherMacs = hasOtherMacs
        self.reaching = reaching; self.reached = reached; self.understanding = understanding; self.hearing = hearing
    }
}

/// One line of the first-day page: a thing the owner allows, whether it is allowed, and why it matters.
public struct DoorSetupItem: Equatable, Sendable {
    public var name: String   // plain words, also what a button names: "pressing buttons"
    public var ok: Bool?      // nil = not known yet
    public var why: String    // one sentence: what does not work without it
    public var page: String   // the System Settings page where the owner allows it
}

/// One setup, everything asked once: a single page that says what is allowed and what is not, with a button
/// that opens the right page in System Settings. The door never changes a setting and never presses Allow.
extension Door {
    nonisolated static let privacy = "x-apple.systempreferences:com.apple.preference.security?"

    /// Everything the owner has to allow, in asking order. The two lines about other Macs only show when there are other Macs.
    public nonisolated static func setupItems(_ f: DoorSetupFacts) -> [DoorSetupItem] {
        var out = [
            DoorSetupItem(name: "pressing buttons", ok: f.pressing,
                          why: "Without it I cannot press buttons, so jobs and standing answers do not work.",
                          page: privacy + "Privacy_Accessibility"),
            DoorSetupItem(name: "seeing the screen", ok: f.seeing,
                          why: "Without it I cannot take a picture of the screen, so I cannot show you what changed.",
                          page: privacy + "Privacy_ScreenCapture"),
            DoorSetupItem(name: "starting when this Mac starts", ok: f.starting,
                          why: "Without it I am gone after a restart until you open me again.",
                          page: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"),
        ]
        if f.hasOtherMacs {
            out.append(DoorSetupItem(name: "reaching your other Macs", ok: f.reaching,
                                     why: "Without it I cannot tell when another Mac goes quiet, so I cannot cover for it.",
                                     page: privacy + "Privacy_LocalNetwork"))
            out.append(DoorSetupItem(name: "being reached by your other Macs", ok: f.reached,
                                     why: "Without it your other Macs cannot tell that this one is still going.",
                                     page: "x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall"))
        }
        out.append(DoorSetupItem(name: "understanding what you say", ok: f.understanding,
                                 why: "Without it I cannot act when you say hands off out loud.",
                                 page: privacy + "Privacy_SpeechRecognition"))
        out.append(DoorSetupItem(name: "hearing you", ok: f.hearing,
                                 why: "Without it I cannot hear you at all.",
                                 page: privacy + "Privacy_Microphone"))
        return out
    }

    /// One plain line for one item.
    public nonisolated static func setupLine(_ i: DoorSetupItem) -> String {
        switch i.ok {
        case true?: return "Allowed: \(i.name)."
        case false?: return "Not yet: \(i.name). \(i.why)"
        case nil: return "Not known yet: \(i.name). \(i.why)"
        }
    }

    /// "5 of 7 allowed"
    public nonisolated static func setupCount(_ items: [DoorSetupItem]) -> String {
        "\(items.filter { $0.ok == true }.count) of \(items.count) allowed"
    }

    /// The line for the top of the main page. Nil when nothing is turned off; a thing not known yet is not counted.
    public nonisolated static func setupNote(_ items: [DoorSetupItem]) -> String? {
        let n = items.filter { $0.ok == false }.count
        guard n > 0 else { return nil }
        return "\(n) thing\(n == 1 ? " is" : "s are") not allowed yet, so some of what I do will not work."
    }

    /// The System Settings page for an item, by its plain name. Nil for anything that is not on the list,
    /// so a button can only ever open one of these pages.
    public nonisolated static func settingsPage(for name: String?) -> URL? {
        guard let want = name?.trimmingCharacters(in: .whitespaces).lowercased(), !want.isEmpty else { return nil }
        var all = DoorSetupFacts(); all.hasOtherMacs = true
        return setupItems(all).first { $0.name.lowercased() == want }.flatMap { URL(string: $0.page) }
    }

    /// Whether this Mac has heard its other Macs: nil when none are named or none was ever tried,
    /// true when one answered in the last five minutes, false when they were tried and none answered.
    public nonisolated static func reaching(peers: [String], seen: [String: [String: Any]], now: Date) -> Bool? {
        guard !peers.isEmpty else { return nil }
        let tried = peers.compactMap { seen[$0] }
        guard !tried.isEmpty else { return nil }
        return tried.contains { st in (st["seen"] as? Double).map { now.timeIntervalSince1970 - $0 <= 300 } ?? false }
    }

    // MARK: what this Mac says right now

    var reportedURL: URL { dir.appendingPathComponent("reported-in.json") }
    /// Another of the owner's Macs got through to this one. Only the time is kept.
    public func noteReport(now: Date = Date()) {
        try? JSONEncoder().encode(["at": now.timeIntervalSince1970]).write(to: reportedURL, options: .atomic)
    }
    /// When another Mac last got through, if one ever did.
    public func lastReport() -> Date? {
        (try? JSONDecoder().decode([String: Double].self, from: Data(contentsOf: reportedURL)))?["at"].map { Date(timeIntervalSince1970: $0) }
    }

    /// The part of the facts that lives in the door's own folder: the other Macs.
    func otherMacs(into f: DoorSetupFacts, now: Date = Date()) -> DoorSetupFacts {
        var f = f
        let names = peers().map(\.name)
        f.hasOtherMacs = !names.isEmpty
        let seen = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: peersSeenURL))) as? [String: [String: Any]]) ?? [:]
        f.reaching = Door.reaching(peers: names, seen: seen, now: now)
        f.reached = names.isEmpty ? nil : (lastReport() != nil ? true : nil)
        return f
    }

    /// Reads the real Mac. It only looks; it never asks for anything, so no box comes up.
    func realSetupFacts(now: Date = Date()) -> DoorSetupFacts {
        func known(_ s: PowerState) -> Bool? { s == .granted ? true : (s == .denied ? false : nil) }
        let agent = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.openrappter.start.plist")
        return otherMacs(into: DoorSetupFacts(
            pressing: AXIsProcessTrusted(), seeing: CGPreflightScreenCaptureAccess(),
            starting: FileManager.default.fileExists(atPath: agent.path),
            understanding: known(Powers.state(.speech)), hearing: known(Powers.state(.microphone))), now: now)
    }

    /// The items as they stand now: from the facts a test handed in, or from the real Mac.
    public func setupNow(now: Date = Date()) -> [DoorSetupItem] {
        Door.setupItems(setupFacts?() ?? realSetupFacts(now: now))
    }

    // MARK: the two asks

    /// setup: says what is allowed, one line each. settings: opens one System Settings page, and nothing more.
    func setup(_ a: DoorAsk, _ ans: inout DoorAnswer) {
        if a.do == "setup" {
            let items = setupNow()
            ans.words = items.map(Door.setupLine)
            ans.said = Door.setupCount(items)
            ans.ok = true
            _ = writePage(hours: 24)
            return
        }
        guard let url = Door.settingsPage(for: a.title) else { ans.said = "I do not know that setting, so I opened nothing"; return }
        let name = (a.title ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if held { ans.said = "hands off is on, so I did not open it. Ask resume to let me work again."; return }
        ans.ok = openSetting(url)
        ans.said = ans.ok ? "opened the setting for \(name). Allowing it is yours to do" : "could not open the setting for \(name)"
    }

    // MARK: the page

    /// Writes the first-day page beside the main page. Its buttons are offers of the same page-load as the main
    /// page's, so they are taken once, the same way. Gives back the line for the top of the main page, or "".
    func writeSetup(token: String, offers: inout [String: DoorAsk], now: Date = Date()) -> String {
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let items = setupNow(now: now)
        var rows = ""
        for i in items {
            let mark = i.ok == true ? "<i class=\"yes\">\u{2713}</i>" : (i.ok == false ? "<i class=\"no\">\u{2717}</i>" : "<i>?</i>")
            let state = i.ok == true ? "Allowed" : (i.ok == false ? "Not yet" : "Not known yet")
            let name = i.name.prefix(1).uppercased() + i.name.dropFirst()
            var row = "<li class=\"ask\">\(mark)<b>\(esc(name))</b> <span>\(state)</span><br><span class=\"why\">\(esc(i.why))</span>"
            if i.ok == false {
                var ask = DoorAsk(id: "", do: "settings"); ask.title = i.name
                let k = "o\(offers.count + 1)"; offers[k] = ask
                row += "<div><a class=\"btn\" href=\"openrappter://pick/\(token)/\(k)\">Open the setting</a></div>"
            }
            rows += row + "</li>"
        }
        let note = Door.setupNote(items)
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="30"><title>Getting set up</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:34px;margin:0}ul{list-style:none;padding:0;margin:24px 0 0}li.ask{padding:12px 0;border-bottom:1px solid #2c2622}
        li b{font-weight:500}li span{opacity:.55}li span.why{opacity:.7}li i{font-style:normal;display:inline-block;width:28px;opacity:.6}
        li i.yes{color:#7fd08a;opacity:1}li i.no{color:#f0a04b;opacity:1}
        li.ask div{margin:10px 0 0 28px;display:flex;gap:10px;flex-wrap:wrap}p{opacity:.6}a{color:#f0a04b}.sub{opacity:.6;margin:4px 0 0}
        .btn{background:#f0a04b;color:#14110f;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:10px}</style>
        <p><a href="page.html" onclick="history.back();return false">Back</a></p>
        <h1>Getting set up</h1><p class="sub">\(esc(Door.setupCount(items)))</p>
        <ul>\(rows)</ul>
        <p>These are yours to allow. I only open the right page.</p>
        """
        try? Data(html.utf8).write(to: dir.appendingPathComponent("setup.html"), options: .atomic)
        return note.map { "<p class=\"sub\"><a href=\"setup.html\" style=\"color:#f0a04b\">\(esc($0))</a></p>" } ?? ""
    }
}
