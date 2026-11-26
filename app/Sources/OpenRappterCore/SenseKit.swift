import Foundation

// OPEN PART. This file is the same in the free OpenRappter and in the paid one.
// A sense is one more way a reply can reach the owner. The mind writes `|||TAG|||` and then the words for it
// (rapp-sense/1.0, the same marker the kernel uses for VOICE). The kernel is never changed: senses are asked for in
// the message and read from the reply, all on the app's side.
//
// Extensions: drop a file `<name>.json` in `~/.openrappter/senses/` and the creature asks for that sense too:
//     { "tag": "WINGMAN", "ask": "one line telling the mind what to put here", "show": true,
//       "press": "Tell Wingman => ask:Tell Wingman this: {value}" }
// "show": true puts the sense's words on the card. "press" is a button made from the sense's words ({value}).
// "then" is one more chat the creature sends by itself right after the turn, made from the sense's words; the first
// line of its answer becomes the sense's words (a bet being placed and coming back with its stake, for example).
// A sense whose words start with "unverified" offers no button and no follow-through.
// Everything sensed is written, one line per reply, to `~/.openrappter/senses/sensed.jsonl`, so any agent file,
// controller or script beside the app can read it. With "button": true the value is offered to the owner as one
// button (`Label => ask:what to do` or `Label => open:https://address`); nothing ever acts without the owner's press.

/// One sense: its marker and what the mind should put after it.
public struct SenseSpec: Codable, Equatable, Sendable {
    public var tag: String
    public var ask: String
    public var button: Bool?
    public var status: String?
    /// Put this sense's words on the card.
    public var show: Bool?
    /// A button made from this sense's words: `Label => ask:... {value}` or `Label => open:https://...{value}`.
    public var press: String?
    /// One more chat sent right after the turn, made from this sense's words ({value}).
    public var then: String?
    public init(tag: String, ask: String, button: Bool? = nil, status: String? = nil, show: Bool? = nil, press: String? = nil, then: String? = nil) {
        self.tag = tag; self.ask = ask; self.button = button; self.status = status; self.show = show; self.press = press; self.then = then
    }
}

/// What one reply carried: its plain text and the words for each sense that was asked for.
public struct Sensed: Equatable, Sendable {
    public var text: String
    public var values: [String: String]
    public init(text: String = "", values: [String: String] = [:]) { self.text = text; self.values = values }
    public subscript(_ tag: String) -> String { values[tag.uppercased()] ?? "" }
}

public enum SenseKit {
    public static let voice = SenseSpec(tag: "VOICE", ask: "what to say out loud: at most two short sentences and 25 words, what needs the owner or went wrong first, at most one number, said the way a person would say it", status: "current")
    public static let glance = SenseSpec(tag: "GLANCE", ask: "one line of at most 10 words for a small card, what needs the owner or went wrong first", status: "staging")
    /// The senses every OpenRappter has.
    public static let open: [SenseSpec] = [voice, glance]

    public static let maxExtensions = 8
    public static let maxValue = 600

    public static var dir: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/senses") }

    /// A spec is usable when its tag fits the marker and its ask is one plain line.
    public static func valid(_ s: SenseSpec) -> Bool {
        s.tag.range(of: #"^[A-Z][A-Z0-9_]{1,15}$"#, options: .regularExpression) != nil
            && !s.ask.isEmpty && s.ask.count <= 400 && !s.ask.contains("\n") && !s.ask.contains("|||")
            && (s.press == nil || pressed(s.press!, value: "x") != nil)
            && (s.then == nil || (s.then!.contains("{value}") && s.then!.count <= 500 && !s.then!.contains("\n") && !s.then!.contains("|||")))
    }

    /// The senses dropped beside the app, by file name. A broken file is skipped, never a crash.
    public static func load(dir: URL = SenseKit.dir) -> [SenseSpec] {
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        var out: [SenseSpec] = []
        for f in files {
            guard let d = try? Data(contentsOf: f), d.count <= 4096, let s = try? JSONDecoder().decode(SenseSpec.self, from: d), valid(s),
                  !out.contains(where: { $0.tag == s.tag }) else { continue }
            out.append(s); if out.count == maxExtensions { break }
        }
        return out
    }

    /// Built-in senses first; an extension can add a sense but never replace a built-in one.
    public static func merged(_ builtIn: [SenseSpec], _ extra: [SenseSpec]) -> [SenseSpec] {
        builtIn + extra.filter { e in valid(e) && !builtIn.contains { $0.tag == e.tag } }
    }

    /// The lines that tell the mind how to answer through these senses.
    public static func instruction(_ specs: [SenseSpec]) -> String {
        "Reply with only these parts, in this order, each starting with its marker. Leave a part out when it has nothing true to say.\n"
            + specs.map { "|||\($0.tag)||| \($0.ask)" }.joined(separator: "\n")
    }

    /// Keeps only the senses that were asked for, trimmed and capped.
    public static func read(text: String, senses: [String: String], specs: [SenseSpec]) -> Sensed {
        var v: [String: String] = [:]
        for s in specs {
            let raw = (senses[s.tag.lowercased()] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !raw.isEmpty { v[s.tag] = String(raw.prefix(maxValue)) }
        }
        return Sensed(text: text.trimmingCharacters(in: .whitespacesAndNewlines), values: v)
    }

    public static func read(_ reply: String, specs: [SenseSpec]) -> Sensed {
        let p = Senses.parse(reply); return read(text: p.text, senses: p.senses, specs: specs)
    }

    /// A button a sense offers: `Label => ask:what to do` or `Label => open:https://address`. Anything else is no button.
    public static func button(_ value: String) -> NeedOption? {
        let parts = value.components(separatedBy: "=>")
        guard parts.count == 2 else { return nil }
        let label = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
        let action = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...32).contains(label.count), !label.contains("\n"), !action.contains("\n") else { return nil }
        if action.hasPrefix("ask:") {
            let q = action.dropFirst(4).trimmingCharacters(in: .whitespaces)
            return (1...200).contains(q.count) ? NeedOption(label: label, action: "ask:" + q) : nil
        }
        if action.hasPrefix("open:") {
            let a = String(action.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard a.count <= 500, let u = URL(string: a), u.scheme == "https", let h = u.host, h.contains(".") else { return nil }
            return NeedOption(label: label, action: "open:" + a)
        }
        return nil
    }

    /// A sense's own button, with its words put where the template says {value}. The words are made one plain line first.
    public static func pressed(_ template: String, value: String) -> NeedOption? {
        let v = value.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "=>", with: "to").trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, template.count <= 300 else { return nil }
        let room = template.contains("ask:") ? 200 - (template.components(separatedBy: "ask:").last ?? "").replacingOccurrences(of: "{value}", with: "").count : 120
        return button(template.replacingOccurrences(of: "{value}", with: String(v.prefix(max(8, room)))))
    }

    /// Every button the senses offer, in the order the senses were asked for.
    public static func buttons(_ sensed: Sensed, specs: [SenseSpec]) -> [NeedOption] {
        var out: [NeedOption] = []
        for s in specs where !sensed[s.tag].isEmpty && !unverified(sensed[s.tag]) {
            let b = s.button == true ? button(sensed[s.tag]) : s.press.flatMap { pressed($0, value: sensed[s.tag]) }
            if let b, !out.contains(where: { $0.label.lowercased() == b.label.lowercased() }) { out.append(b) }
        }
        return out
    }
    public static func button(_ sensed: Sensed, specs: [SenseSpec]) -> NeedOption? { buttons(sensed, specs: specs).first }

    /// "unverified" is the kit's word for "nothing here to press or act on".
    public static func unverified(_ value: String) -> Bool { value.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("unverified") }

    /// The one follow-through chat this reply asks for, if any: the first sense with a "then" and usable words.
    public static func followThrough(_ sensed: Sensed, specs: [SenseSpec]) -> (tag: String, message: String)? {
        for s in specs { if let t = s.then, !sensed[s.tag].isEmpty, !unverified(sensed[s.tag]) {
            return (s.tag, t.replacingOccurrences(of: "{value}", with: String(sensed[s.tag].replacingOccurrences(of: "\n", with: " ").prefix(300))))
        } }
        return nil
    }

    /// The reply with a follow-through's answer put in as that sense's words (its first line).
    public static func followed(_ sensed: Sensed, tag: String, answer: String) -> Sensed {
        let line = answer.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        guard !line.isEmpty else { return sensed }
        var s = sensed; s.values[tag.uppercased()] = String(line.prefix(200)); return s
    }

    /// The words that senses marked "show" put on the card, one line each.
    public static func lines(_ sensed: Sensed, specs: [SenseSpec]) -> [String] {
        specs.filter { $0.show == true && !sensed[$0.tag].isEmpty }.map { String(sensed[$0.tag].replacingOccurrences(of: "\n", with: " ").prefix(110)) }
    }

    /// One line per reply, for anything beside the app to read. The file is kept under about 2 MB.
    public static func record(_ sensed: Sensed, about: String, dir: URL = SenseKit.dir, now: Date = Date()) {
        guard !sensed.values.isEmpty else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let line: [String: Any] = ["schema": "openrappter-sensed/1", "at": ISO8601DateFormatter().string(from: now), "about": about, "senses": sensed.values]
        guard var data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        let url = dir.appendingPathComponent("sensed.jsonl")
        if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 2_000_000 {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("sensed.old.jsonl"))
            try? FileManager.default.moveItem(at: url, to: dir.appendingPathComponent("sensed.old.jsonl"))
        }
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() }
        else { try? data.write(to: url) }
    }
}
