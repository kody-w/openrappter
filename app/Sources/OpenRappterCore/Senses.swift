import Foundation

/// A reply split into its main text and its sense projections (rapp-sense/1.0).
/// Port of openrappter v1 `channels/senses.ts`, same semantics so both surfaces read one shape:
/// text = everything before the first `|||TAG|||`; each tag owns the text up to the next tag;
/// empty blocks dropped; duplicate tags, last one wins; tags lower-cased.
public struct ParsedSenses: Equatable, Sendable {
    public var text: String
    public var senses: [String: String]
    public init(text: String, senses: [String: String]) { self.text = text; self.senses = senses }
    /// The spoken (`|||VOICE|||`) projection, or "" if none.
    public var voice: String { senses["voice"] ?? "" }
}

public enum Senses {
    private static let marker = try! NSRegularExpression(pattern: #"\|\|\|([A-Z][A-Z0-9_]{1,15})\|\|\|"#)

    public static func parse(_ reply: String) -> ParsedSenses {
        if reply.isEmpty { return ParsedSenses(text: "", senses: [:]) }
        let ns = reply as NSString
        let matches = marker.matches(in: reply, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty {
            return ParsedSenses(text: reply.trimmingCharacters(in: .whitespacesAndNewlines), senses: [:])
        }
        let text = ns.substring(to: matches[0].range.location).trimmingCharacters(in: .whitespacesAndNewlines)
        var senses: [String: String] = [:]
        for (i, m) in matches.enumerated() {
            let tag = ns.substring(with: m.range(at: 1)).lowercased()
            let start = m.range.location + m.range.length
            let stop = i + 1 < matches.count ? matches[i + 1].range.location : ns.length
            let content = ns.substring(with: NSRange(location: start, length: stop - start))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !content.isEmpty { senses[tag] = content }
        }
        return ParsedSenses(text: text, senses: senses)
    }
}
